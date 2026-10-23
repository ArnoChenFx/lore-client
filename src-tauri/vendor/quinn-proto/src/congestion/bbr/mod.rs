use std::any::Any;
use std::fmt::Debug;
use std::sync::Arc;

use rand::{RngExt, SeedableRng};
use rand_pcg::Pcg32;

use crate::congestion::ControllerMetrics;
use crate::congestion::bbr::bw_estimation::BandwidthEstimation;
use crate::congestion::bbr::min_max::MinMax;
use crate::connection::RttEstimator;
use crate::{Duration, Instant};

use super::{BASE_DATAGRAM_SIZE, Controller, ControllerFactory};

mod bw_estimation;
mod min_max;

/// Experimental! Use at your own risk.
///
/// Aims for reduced buffer bloat and improved performance over high bandwidth-delay product networks.
/// Based on google's quiche implementation <https://source.chromium.org/chromium/chromium/src/+/master:net/third_party/quiche/src/quic/core/congestion_control/bbr_sender.cc>
/// of BBR <https://datatracker.ietf.org/doc/html/draft-cardwell-iccrg-bbr-congestion-control>.
/// More discussion and links at <https://groups.google.com/g/bbr-dev>.
#[derive(Debug, Clone)]
pub struct Bbr {
    config: Arc<BbrConfig>,
    current_mtu: u64,
    max_bandwidth: BandwidthEstimation,
    acked_bytes: u64,
    mode: Mode,
    loss_state: LossState,
    recovery_state: RecoveryState,
    recovery_window: u64,
    is_at_full_bandwidth: bool,
    pacing_gain: f32,
    high_gain: f32,
    drain_gain: f32,
    cwnd_gain: f32,
    high_cwnd_gain: f32,
    last_cycle_start: Option<Instant>,
    current_cycle_offset: u8,
    init_cwnd: u64,
    min_cwnd: u64,
    prev_in_flight_count: u64,
    exit_probe_rtt_at: Option<Instant>,
    probe_rtt_last_started_at: Option<Instant>,
    min_rtt: Duration,
    /// When the sample in `min_rtt` was taken. LORE: not upstream, see `on_ack`.
    min_rtt_timestamp: Option<Instant>,
    exiting_quiescence: bool,
    pacing_rate: u64,
    max_acked_packet_number: u64,
    max_sent_packet_number: u64,
    end_recovery_at_packet_number: u64,
    cwnd: u64,
    current_round_trip_end_packet_number: u64,
    round_count: u64,
    bw_at_last_round: u64,
    round_wo_bw_gain: u64,
    ack_aggregation: AckAggregationState,
    random_number_generator: Pcg32,
}

impl Bbr {
    /// Construct a state using the given `config` and current time `now`
    pub fn new(config: Arc<BbrConfig>, current_mtu: u16) -> Self {
        // LORE: the initial window is floored at the minimum window, as `on_mtu_update` floors it,
        // where upstream took the configured value as given. quinn holds back a packet that would
        // fill the window, so a configured window of one packet or less stopped every send.
        let min_cwnd = calculate_min_window(current_mtu as u64);
        let initial_window = config.initial_window.max(min_cwnd);
        Self {
            config,
            current_mtu: current_mtu as u64,
            max_bandwidth: BandwidthEstimation::default(),
            acked_bytes: 0,
            mode: Mode::Startup,
            loss_state: Default::default(),
            recovery_state: RecoveryState::NotInRecovery,
            recovery_window: 0,
            is_at_full_bandwidth: false,
            pacing_gain: K_DEFAULT_HIGH_GAIN,
            high_gain: K_DEFAULT_HIGH_GAIN,
            drain_gain: 1.0 / K_DEFAULT_HIGH_GAIN,
            cwnd_gain: K_DEFAULT_HIGH_GAIN,
            high_cwnd_gain: K_DEFAULT_HIGH_GAIN,
            last_cycle_start: None,
            current_cycle_offset: 0,
            init_cwnd: initial_window,
            min_cwnd,
            prev_in_flight_count: 0,
            exit_probe_rtt_at: None,
            probe_rtt_last_started_at: None,
            min_rtt: Default::default(),
            // LORE: not upstream.
            min_rtt_timestamp: None,
            exiting_quiescence: false,
            pacing_rate: 0,
            max_acked_packet_number: 0,
            max_sent_packet_number: 0,
            end_recovery_at_packet_number: 0,
            cwnd: initial_window,
            current_round_trip_end_packet_number: 0,
            round_count: 0,
            bw_at_last_round: 0,
            round_wo_bw_gain: 0,
            ack_aggregation: AckAggregationState::default(),
            random_number_generator: Pcg32::from_rng(&mut rand::rng()),
        }
    }

    fn enter_startup_mode(&mut self) {
        self.mode = Mode::Startup;
        self.pacing_gain = self.high_gain;
        self.cwnd_gain = self.high_cwnd_gain;
    }

    fn enter_probe_bandwidth_mode(&mut self, now: Instant) {
        self.mode = Mode::ProbeBw;
        self.cwnd_gain = K_DERIVED_HIGH_CWNDGAIN;
        self.last_cycle_start = Some(now);
        // Pick a random offset for the gain cycle out of {0, 2..7} range. 1 is
        // excluded because in that case increased gain and decreased gain would not
        // follow each other.
        let mut rand_index = self
            .random_number_generator
            .random_range(0..K_PACING_GAIN.len() as u8 - 1);
        if rand_index >= 1 {
            rand_index += 1;
        }
        self.current_cycle_offset = rand_index;
        self.pacing_gain = K_PACING_GAIN[rand_index as usize];
    }

    fn update_recovery_state(&mut self, is_round_start: bool) {
        // Exit recovery when there are no losses for a round.
        if self.loss_state.has_losses() {
            self.end_recovery_at_packet_number = self.max_sent_packet_number;
        }
        match self.recovery_state {
            // Enter conservation on the first loss.
            RecoveryState::NotInRecovery if self.loss_state.has_losses() => {
                self.recovery_state = RecoveryState::Conservation;
                // This will cause the |recovery_window| to be set to the
                // correct value in CalculateRecoveryWindow().
                self.recovery_window = 0;
                // Since the conservation phase is meant to be lasting for a whole
                // round, extend the current round as if it were started right now.
                self.current_round_trip_end_packet_number = self.max_sent_packet_number;
            }
            RecoveryState::Growth | RecoveryState::Conservation => {
                if self.recovery_state == RecoveryState::Conservation && is_round_start {
                    self.recovery_state = RecoveryState::Growth;
                }
                // Exit recovery if appropriate.
                if !self.loss_state.has_losses()
                    && self.max_acked_packet_number > self.end_recovery_at_packet_number
                {
                    self.recovery_state = RecoveryState::NotInRecovery;
                }
            }
            _ => {}
        }
    }

    fn update_gain_cycle_phase(&mut self, now: Instant, in_flight: u64) {
        // In most cases, the cycle is advanced after an RTT passes.
        // LORE: `bounded_min_rtt()`, where upstream read `self.min_rtt`.
        let mut should_advance_gain_cycling = self
            .last_cycle_start
            .map(|last_cycle_start| now.duration_since(last_cycle_start) > self.bounded_min_rtt())
            .unwrap_or(false);
        // If the pacing gain is above 1.0, the connection is trying to probe the
        // bandwidth by increasing the number of bytes in flight to at least
        // pacing_gain * BDP.  Make sure that it actually reaches the target, as
        // long as there are no losses suggesting that the buffers are not able to
        // hold that much.
        if self.pacing_gain > 1.0
            && !self.loss_state.has_losses()
            && self.prev_in_flight_count < self.get_target_cwnd(self.pacing_gain)
        {
            should_advance_gain_cycling = false;
        }

        // If pacing gain is below 1.0, the connection is trying to drain the extra
        // queue which could have been incurred by probing prior to it.  If the
        // number of bytes in flight falls down to the estimated BDP value earlier,
        // conclude that the queue has been successfully drained and exit this cycle
        // early.
        if self.pacing_gain < 1.0 && in_flight <= self.get_target_cwnd(1.0) {
            should_advance_gain_cycling = true;
        }

        if should_advance_gain_cycling {
            self.current_cycle_offset = (self.current_cycle_offset + 1) % K_PACING_GAIN.len() as u8;
            self.last_cycle_start = Some(now);
            // Stay in low gain mode until the target BDP is hit.  Low gain mode
            // will be exited immediately when the target BDP is achieved.
            if DRAIN_TO_TARGET
                && self.pacing_gain < 1.0
                && (K_PACING_GAIN[self.current_cycle_offset as usize] - 1.0).abs() < f32::EPSILON
                && in_flight > self.get_target_cwnd(1.0)
            {
                return;
            }
            self.pacing_gain = K_PACING_GAIN[self.current_cycle_offset as usize];
        }
    }

    fn maybe_exit_startup_or_drain(&mut self, now: Instant, in_flight: u64) {
        if self.mode == Mode::Startup && self.is_at_full_bandwidth {
            self.mode = Mode::Drain;
            self.pacing_gain = self.drain_gain;
            self.cwnd_gain = self.high_cwnd_gain;
        }
        if self.mode == Mode::Drain && in_flight <= self.get_target_cwnd(1.0) {
            self.enter_probe_bandwidth_mode(now);
        }
    }

    fn is_min_rtt_expired(&self, now: Instant, app_limited: bool) -> bool {
        !app_limited
            && self
                .probe_rtt_last_started_at
                .map(|last| now.saturating_duration_since(last) > Duration::from_secs(10))
                .unwrap_or(true)
    }

    fn maybe_enter_or_exit_probe_rtt(
        &mut self,
        now: Instant,
        is_round_start: bool,
        bytes_in_flight: u64,
        app_limited: bool,
    ) {
        let min_rtt_expired = self.is_min_rtt_expired(now, app_limited);
        if min_rtt_expired && !self.exiting_quiescence && self.mode != Mode::ProbeRtt {
            self.mode = Mode::ProbeRtt;
            self.pacing_gain = 1.0;
            // Do not decide on the time to exit ProbeRtt until the
            // |bytes_in_flight| is at the target small value.
            self.exit_probe_rtt_at = None;
            self.probe_rtt_last_started_at = Some(now);
        }

        if self.mode == Mode::ProbeRtt {
            match self.exit_probe_rtt_at {
                None => {
                    // If the window has reached the appropriate size, schedule exiting
                    // ProbeRtt.  The CWND during ProbeRtt is
                    // kMinimumCongestionWindow, but we allow an extra packet since QUIC
                    // checks CWND before sending a packet.
                    if bytes_in_flight < self.get_probe_rtt_cwnd() + self.current_mtu {
                        const K_PROBE_RTT_TIME: Duration = Duration::from_millis(200);
                        self.exit_probe_rtt_at = Some(now + K_PROBE_RTT_TIME);
                    }
                }
                Some(exit_time) if is_round_start && now >= exit_time => {
                    if !self.is_at_full_bandwidth {
                        self.enter_startup_mode();
                    } else {
                        self.enter_probe_bandwidth_mode(now);
                    }
                }
                Some(_) => {}
            }
        }

        self.exiting_quiescence = false;
    }

    /// `min_rtt` as BBR sizes and times with it: never below `K_MIN_RTT_FLOOR`.
    ///
    /// LORE: not upstream. Re-apply this, its callers and `K_MIN_RTT_FLOOR` when re-vendoring.
    fn bounded_min_rtt(&self) -> Duration {
        self.min_rtt.max(K_MIN_RTT_FLOOR)
    }

    /// `BbrConfig::max_window`, never below the minimum window. quinn holds back a packet that
    /// would fill the window, so a cap of one packet or less would stop every send, the handshake
    /// included.
    ///
    /// LORE: not upstream. Re-apply this with `BbrConfig::max_window` when re-vendoring.
    fn bounded_max_window(&self) -> u64 {
        self.config.max_window.max(self.min_cwnd)
    }

    fn get_target_cwnd(&self, gain: f32) -> u64 {
        let bw = self.max_bandwidth.get_estimate();
        // LORE: `bounded_min_rtt()`, where upstream read `self.min_rtt`.
        let bdp = self.bounded_min_rtt().as_micros() as u64 * bw;
        let bdpf = bdp as f64;
        let cwnd = ((gain as f64 * bdpf) / 1_000_000f64) as u64;
        // BDP estimate will be zero if no bandwidth samples are available yet.
        if cwnd == 0 {
            return self.init_cwnd;
        }
        cwnd.max(self.min_cwnd)
    }

    fn get_probe_rtt_cwnd(&self) -> u64 {
        const K_MODERATE_PROBE_RTT_MULTIPLIER: f32 = 0.75;
        if PROBE_RTT_BASED_ON_BDP {
            return self.get_target_cwnd(K_MODERATE_PROBE_RTT_MULTIPLIER);
        }
        self.min_cwnd
    }

    fn calculate_pacing_rate(&mut self) {
        let bw = self.max_bandwidth.get_estimate();
        if bw == 0 {
            return;
        }
        let target_rate = (bw as f64 * self.pacing_gain as f64) as u64;
        if self.is_at_full_bandwidth {
            self.pacing_rate = target_rate;
            return;
        }

        // Pace at the rate of initial_window / RTT as soon as RTT measurements are
        // available.
        if self.pacing_rate == 0 && self.min_rtt.as_nanos() != 0 {
            // LORE: `bounded_min_rtt()`, where upstream read `self.min_rtt`.
            self.pacing_rate =
                BandwidthEstimation::bw_from_delta(self.init_cwnd, self.bounded_min_rtt()).unwrap();
            return;
        }

        // Do not decrease the pacing rate during startup.
        if self.pacing_rate < target_rate {
            self.pacing_rate = target_rate;
        }
    }

    // LORE: not upstream. Three changes bring this back to the Chromium sender it is ported from:
    // STARTUP grows the window only while it is below the target, where upstream compared
    // `cwnd_gain` with the target and so grew it on every ack; STARTUP leaves ack aggregation out of
    // the target, as Chromium does by default, since with no bandwidth estimate yet every acked byte
    // counts as excess; and the window is capped at `BbrConfig::max_window`, floored at the minimum
    // window. Re-apply all three, the `max_window` setting and its tests when re-vendoring.
    fn calculate_cwnd(&mut self, bytes_acked: u64) {
        if self.mode == Mode::ProbeRtt {
            return;
        }
        let mut target_window = self.get_target_cwnd(self.cwnd_gain);
        if self.is_at_full_bandwidth {
            // Add the max recently measured ack aggregation to CWND.
            target_window += self.ack_aggregation.max_ack_height.get();
        }
        // LORE: upstream added `excess_acked` to the target in STARTUP here.
        // Instead of immediately setting the target CWND as the new one, BBR grows
        // the CWND towards |target_window| by only increasing it |bytes_acked| at a
        // time.
        // LORE: STARTUP tests `self.cwnd < target_window`, where upstream tested `self.cwnd_gain`.
        if self.is_at_full_bandwidth {
            self.cwnd = target_window.min(self.cwnd + bytes_acked);
        } else if self.cwnd < target_window || self.acked_bytes < self.init_cwnd {
            // If the connection is not yet out of startup phase, do not decrease
            // the window.
            self.cwnd += bytes_acked;
        }

        // Enforce the limits on the congestion window.
        if self.cwnd < self.min_cwnd {
            self.cwnd = self.min_cwnd;
        }
        // LORE: the cap at `max_window`.
        self.cwnd = self.cwnd.min(self.bounded_max_window());
    }

    fn calculate_recovery_window(&mut self, bytes_acked: u64, bytes_lost: u64, in_flight: u64) {
        if !self.recovery_state.in_recovery() {
            return;
        }
        // Set up the initial recovery window.
        if self.recovery_window == 0 {
            self.recovery_window = self.min_cwnd.max(in_flight + bytes_acked);
            return;
        }

        // Remove losses from the recovery window, while accounting for a potential
        // integer underflow.
        if self.recovery_window >= bytes_lost {
            self.recovery_window -= bytes_lost;
        } else {
            // k_max_segment_size = current_mtu
            self.recovery_window = self.current_mtu;
        }
        // In CONSERVATION mode, just subtracting losses is sufficient.  In GROWTH,
        // release additional |bytes_acked| to achieve a slow-start-like behavior.
        if self.recovery_state == RecoveryState::Growth {
            self.recovery_window += bytes_acked;
        }

        // Sanity checks.  Ensure that we always allow to send at least an MSS or
        // |bytes_acked| in response, whichever is larger.
        self.recovery_window = self
            .recovery_window
            .max(in_flight + bytes_acked)
            .max(self.min_cwnd);
    }

    /// <https://datatracker.ietf.org/doc/html/draft-cardwell-iccrg-bbr-congestion-control#section-4.3.2.2>
    fn check_if_full_bw_reached(&mut self, app_limited: bool) {
        if app_limited {
            return;
        }
        let target = (self.bw_at_last_round as f64 * K_STARTUP_GROWTH_TARGET as f64) as u64;
        let bw = self.max_bandwidth.get_estimate();
        if bw >= target {
            self.bw_at_last_round = bw;
            self.round_wo_bw_gain = 0;
            self.ack_aggregation.max_ack_height.reset();
            return;
        }

        self.round_wo_bw_gain += 1;
        if self.round_wo_bw_gain >= K_ROUND_TRIPS_WITHOUT_GROWTH_BEFORE_EXITING_STARTUP as u64
            || (self.recovery_state.in_recovery())
        {
            self.is_at_full_bandwidth = true;
        }
    }
}

impl Controller for Bbr {
    fn on_sent(&mut self, now: Instant, bytes: u64, last_packet_number: u64) {
        self.max_sent_packet_number = last_packet_number;
        self.max_bandwidth.on_sent(now, bytes);
    }

    fn on_ack(
        &mut self,
        now: Instant,
        sent: Instant,
        bytes: u64,
        app_limited: bool,
        rtt: &RttEstimator,
    ) {
        self.max_bandwidth
            .on_ack(now, sent, bytes, self.round_count, app_limited);
        self.acked_bytes += bytes;
        // LORE: not upstream. A windowed minimum of RTT samples, as in the BBR draft, in place of
        // the estimator's all-time minimum, which keeps an underestimated sample forever. A sample
        // equal to the minimum restamps it, as the draft's `<=` does, so a steady path keeps it.
        // The stamp is when the sample was taken, not `now`: quinn records an ack's own sample
        // after this call, so the sample here can predate an idle period. Re-apply this, the
        // `min_rtt_timestamp` field and `K_MIN_RTT_WINDOW` when re-vendoring.
        let Some((sample, taken_at)) = rtt.latest() else {
            return;
        };
        let expired = self
            .min_rtt_timestamp
            .is_none_or(|at| now.saturating_duration_since(at) > K_MIN_RTT_WINDOW);
        if expired || sample <= self.min_rtt {
            self.min_rtt = sample;
            self.min_rtt_timestamp = Some(taken_at);
        }
    }

    fn on_end_acks(
        &mut self,
        now: Instant,
        in_flight: u64,
        app_limited: bool,
        largest_packet_num_acked: Option<u64>,
    ) {
        let bytes_acked = self.max_bandwidth.bytes_acked_this_window();
        // LORE: the excess this returns no longer reaches `calculate_cwnd`; the call still updates
        // `max_ack_height`.
        self.ack_aggregation.update_ack_aggregation_bytes(
            bytes_acked,
            now,
            self.round_count,
            self.max_bandwidth.get_estimate(),
        );
        self.max_bandwidth.end_acks(self.round_count, app_limited);
        if let Some(largest_acked_packet) = largest_packet_num_acked {
            self.max_acked_packet_number = largest_acked_packet;
        }

        let mut is_round_start = false;
        if bytes_acked > 0 {
            is_round_start =
                self.max_acked_packet_number > self.current_round_trip_end_packet_number;
            if is_round_start {
                self.current_round_trip_end_packet_number = self.max_sent_packet_number;
                self.round_count += 1;
            }
        }

        self.update_recovery_state(is_round_start);

        if self.mode == Mode::ProbeBw {
            self.update_gain_cycle_phase(now, in_flight);
        }

        if is_round_start && !self.is_at_full_bandwidth {
            self.check_if_full_bw_reached(app_limited);
        }

        self.maybe_exit_startup_or_drain(now, in_flight);

        self.maybe_enter_or_exit_probe_rtt(now, is_round_start, in_flight, app_limited);

        // After the model is updated, recalculate the pacing rate and congestion window.
        self.calculate_pacing_rate();
        // LORE: upstream also passed `excess_acked`.
        self.calculate_cwnd(bytes_acked);
        self.calculate_recovery_window(bytes_acked, self.loss_state.lost_bytes, in_flight);

        self.prev_in_flight_count = in_flight;
        self.loss_state.reset();
    }

    fn on_congestion_event(
        &mut self,
        _now: Instant,
        _sent: Instant,
        _is_persistent_congestion: bool,
        lost_bytes: u64,
    ) {
        self.loss_state.lost_bytes += lost_bytes;
    }

    fn on_mtu_update(&mut self, new_mtu: u16) {
        self.current_mtu = new_mtu as u64;
        self.min_cwnd = calculate_min_window(self.current_mtu);
        self.init_cwnd = self.config.initial_window.max(self.min_cwnd);
        self.cwnd = self.cwnd.max(self.min_cwnd);
    }

    fn window(&self) -> u64 {
        // LORE: capped at `max_window` on every path, ProbeRTT and recovery included, where
        // upstream returned each window as computed.
        let window = if self.mode == Mode::ProbeRtt {
            self.get_probe_rtt_cwnd()
        } else if self.recovery_state.in_recovery() && self.mode != Mode::Startup {
            self.cwnd.min(self.recovery_window)
        } else {
            self.cwnd
        };
        window.min(self.bounded_max_window())
    }

    fn metrics(&self) -> ControllerMetrics {
        ControllerMetrics {
            congestion_window: self.window(),
            ssthresh: None,
            pacing_rate: Some(self.pacing_rate * 8),
        }
    }

    fn clone_box(&self) -> Box<dyn Controller> {
        Box::new(self.clone())
    }

    fn initial_window(&self) -> u64 {
        // LORE: the floored initial window capped at `max_window`, where upstream returned the
        // configured value; quinn sizes the pacer's first burst by this.
        self.init_cwnd.min(self.bounded_max_window())
    }

    fn into_any(self: Box<Self>) -> Box<dyn Any> {
        self
    }
}

/// Configuration for the [`Bbr`] congestion controller
#[derive(Debug, Clone)]
pub struct BbrConfig {
    initial_window: u64,
    /// LORE: not upstream, see [`BbrConfig::max_window`].
    max_window: u64,
}

impl BbrConfig {
    /// Default limit on the amount of outstanding data in bytes.
    ///
    /// Recommended value: `min(10 * max_datagram_size, max(2 * max_datagram_size, 14720))`
    ///
    /// LORE: never below the minimum window of four packets, where upstream took it as given.
    pub fn initial_window(&mut self, value: u64) -> &mut Self {
        self.initial_window = value;
        self
    }

    /// Upper bound on the congestion window in bytes, never below the minimum window of four
    /// packets. Unbounded by default.
    ///
    /// LORE: not upstream. Re-apply this, the `max_window` field and its default when
    /// re-vendoring.
    pub fn max_window(&mut self, value: u64) -> &mut Self {
        self.max_window = value;
        self
    }
}

impl Default for BbrConfig {
    fn default() -> Self {
        Self {
            initial_window: K_MAX_INITIAL_CONGESTION_WINDOW * BASE_DATAGRAM_SIZE,
            // LORE: not upstream.
            max_window: u64::MAX,
        }
    }
}

impl ControllerFactory for BbrConfig {
    fn build(self: Arc<Self>, _now: Instant, current_mtu: u16) -> Box<dyn Controller> {
        Box::new(Bbr::new(self, current_mtu))
    }
}

#[derive(Debug, Default, Copy, Clone)]
struct AckAggregationState {
    max_ack_height: MinMax,
    aggregation_epoch_start_time: Option<Instant>,
    aggregation_epoch_bytes: u64,
}

impl AckAggregationState {
    fn update_ack_aggregation_bytes(
        &mut self,
        newly_acked_bytes: u64,
        now: Instant,
        round: u64,
        max_bandwidth: u64,
    ) -> u64 {
        // Compute how many bytes are expected to be delivered, assuming max
        // bandwidth is correct.
        let expected_bytes_acked = max_bandwidth
            * now
                .saturating_duration_since(self.aggregation_epoch_start_time.unwrap_or(now))
                .as_micros() as u64
            / 1_000_000;

        // Reset the current aggregation epoch as soon as the ack arrival rate is
        // less than or equal to the max bandwidth.
        if self.aggregation_epoch_bytes <= expected_bytes_acked {
            // Reset to start measuring a new aggregation epoch.
            self.aggregation_epoch_bytes = newly_acked_bytes;
            self.aggregation_epoch_start_time = Some(now);
            return 0;
        }

        // Compute how many extra bytes were delivered vs max bandwidth.
        // Include the bytes most recently acknowledged to account for stretch acks.
        self.aggregation_epoch_bytes += newly_acked_bytes;
        let diff = self.aggregation_epoch_bytes - expected_bytes_acked;
        self.max_ack_height.update_max(round, diff);
        diff
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum Mode {
    // Startup phase of the connection.
    Startup,
    // After achieving the highest possible bandwidth during the startup, lower
    // the pacing rate in order to drain the queue.
    Drain,
    // Cruising mode.
    ProbeBw,
    // Temporarily slow down sending in order to empty the buffer and measure
    // the real minimum RTT.
    ProbeRtt,
}

// Indicates how the congestion control limits the amount of bytes in flight.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum RecoveryState {
    // Do not limit.
    NotInRecovery,
    // Allow an extra outstanding byte for each byte acknowledged.
    Conservation,
    // Allow two extra outstanding bytes for each byte acknowledged (slow
    // start).
    Growth,
}

impl RecoveryState {
    pub(super) fn in_recovery(&self) -> bool {
        !matches!(self, Self::NotInRecovery)
    }
}

#[derive(Debug, Clone, Default)]
struct LossState {
    lost_bytes: u64,
}

impl LossState {
    pub(super) fn reset(&mut self) {
        self.lost_bytes = 0;
    }

    pub(super) fn has_losses(&self) -> bool {
        self.lost_bytes != 0
    }
}

fn calculate_min_window(current_mtu: u64) -> u64 {
    4 * current_mtu
}

// The gain used for the STARTUP, equal to 2/ln(2).
const K_DEFAULT_HIGH_GAIN: f32 = 2.885;
// The newly derived CWND gain for STARTUP, 2.
const K_DERIVED_HIGH_CWNDGAIN: f32 = 2.0;
// The cycle of gains used during the ProbeBw stage.
const K_PACING_GAIN: [f32; 8] = [1.25, 0.75, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];

const K_STARTUP_GROWTH_TARGET: f32 = 1.25;
const K_ROUND_TRIPS_WITHOUT_GROWTH_BEFORE_EXITING_STARTUP: u8 = 3;

// Do not allow initial congestion window to be greater than 200 packets.
const K_MAX_INITIAL_CONGESTION_WINDOW: u64 = 200;

// LORE: not upstream. How long a min_rtt sample stands before a higher one replaces it.
const K_MIN_RTT_WINDOW: Duration = Duration::from_secs(10);
// LORE: not upstream. The least min_rtt BBR sizes and times with. quinn's receive loop stamps a
// whole batch of datagrams with one time, so on a sub-millisecond path an RTT sample can come out
// far too small, even zero, and would shrink the window far below what the path carries. On a path
// shorter than the floor, BBR keeps more in flight than the path needs, and the excess queues at
// the sender: on a 100 µs, 5 Gbit/s path the median RTT rose from about 300 µs with no floor to
// about 350 µs at 100 µs, 420 µs at 250 µs and 460 µs at 1 ms, while throughput rose by 2% at
// 250 µs.
const K_MIN_RTT_FLOOR: Duration = Duration::from_micros(250);

const PROBE_RTT_BASED_ON_BDP: bool = true;
const DRAIN_TO_TARGET: bool = true;

// LORE: not upstream. Tests for the windowed min_rtt and its floor.
#[cfg(test)]
mod tests {
    use super::*;

    fn bbr() -> Bbr {
        Bbr::new(Arc::new(BbrConfig::default()), 1200)
    }

    /// An estimator as a connection holds it: one for the connection's life, fed every sample.
    fn estimator() -> RttEstimator {
        RttEstimator::new(Duration::from_millis(333), Duration::from_secs(60))
    }

    /// Acks one packet at `now`, then records the ack's RTT `sample`, in the order
    /// `Connection::on_ack_received` does: BBR sees a sample at the following ack.
    fn ack(bbr: &mut Bbr, rtt: &mut RttEstimator, now: Instant, sample: Duration) {
        bbr.on_ack(now, now, 1200, false, rtt);
        rtt.update(Duration::ZERO, sample, now);
    }

    /// Acks one packet at `now` without a new RTT sample.
    fn ack_without_sample(bbr: &mut Bbr, rtt: &RttEstimator, now: Instant) {
        bbr.on_ack(now, now, 1200, false, rtt);
    }

    fn ms(millis: u64) -> Duration {
        Duration::from_millis(millis)
    }

    #[test]
    fn min_rtt_takes_a_lower_sample() {
        let start = Instant::now();
        let (mut bbr, mut rtt) = (bbr(), estimator());
        ack(&mut bbr, &mut rtt, start, ms(50));
        ack(&mut bbr, &mut rtt, start + ms(60), ms(20));
        ack_without_sample(&mut bbr, &rtt, start + ms(61));
        assert_eq!(bbr.min_rtt, ms(20));
    }

    #[test]
    fn min_rtt_takes_a_first_sample_above_the_initial_estimate() {
        let start = Instant::now();
        let (mut bbr, mut rtt) = (bbr(), estimator());
        ack_without_sample(&mut bbr, &rtt, start);
        ack(&mut bbr, &mut rtt, start + ms(600), ms(600));
        ack_without_sample(&mut bbr, &rtt, start + ms(601));
        assert_eq!(bbr.min_rtt, ms(600));
    }

    #[test]
    fn min_rtt_keeps_a_lower_value_within_the_window() {
        let start = Instant::now();
        let (mut bbr, mut rtt) = (bbr(), estimator());
        ack(&mut bbr, &mut rtt, start, ms(20));
        ack(&mut bbr, &mut rtt, start + K_MIN_RTT_WINDOW, ms(50));
        ack_without_sample(&mut bbr, &rtt, start + K_MIN_RTT_WINDOW);
        assert_eq!(bbr.min_rtt, ms(20));
    }

    #[test]
    fn min_rtt_keeps_a_value_an_equal_sample_renewed() {
        let start = Instant::now();
        let (mut bbr, mut rtt) = (bbr(), estimator());
        ack(&mut bbr, &mut rtt, start, ms(20));
        ack(&mut bbr, &mut rtt, start + ms(5_000), ms(20));
        ack(&mut bbr, &mut rtt, start + ms(5_001), ms(30));
        ack(&mut bbr, &mut rtt, start + ms(10_100), ms(50));
        ack_without_sample(&mut bbr, &rtt, start + ms(10_101));
        assert_eq!(bbr.min_rtt, ms(20));
    }

    #[test]
    fn min_rtt_forgets_an_underestimated_sample_when_the_window_expires() {
        let start = Instant::now();
        let (mut bbr, mut rtt) = (bbr(), estimator());
        ack(&mut bbr, &mut rtt, start, ms(20));
        ack(&mut bbr, &mut rtt, start + ms(1), Duration::from_micros(20));
        ack(&mut bbr, &mut rtt, start + ms(2), ms(20));
        assert_eq!(bbr.min_rtt, Duration::from_micros(20));
        let after_window = start + ms(1) + K_MIN_RTT_WINDOW + ms(1);
        ack(&mut bbr, &mut rtt, after_window, ms(20));
        ack_without_sample(&mut bbr, &rtt, after_window + ms(1));
        assert_eq!(bbr.min_rtt, ms(20));
    }

    #[test]
    fn min_rtt_forgets_a_sample_taken_before_an_idle_period() {
        let start = Instant::now();
        let (mut bbr, mut rtt) = (bbr(), estimator());
        ack(&mut bbr, &mut rtt, start, ms(20));
        ack(&mut bbr, &mut rtt, start + ms(1), Duration::from_micros(20));
        // The first ack after the idle period sees the sample taken before it.
        let after_idle = start + ms(20_000);
        ack(&mut bbr, &mut rtt, after_idle, ms(20));
        ack_without_sample(&mut bbr, &rtt, after_idle + ms(1));
        assert_eq!(bbr.min_rtt, ms(20));
    }

    #[test]
    fn target_window_sizes_by_the_floor_when_min_rtt_is_below_it() {
        let start = Instant::now();
        let mut bbr = bbr();
        // 1 MB sent and acked per millisecond: 1 GB/s.
        bbr.on_sent(start, 1_000_000, 1);
        bbr.on_sent(start + ms(1), 1_000_000, 2);
        let mut rtt = estimator();
        rtt.update(Duration::ZERO, Duration::from_micros(20), start);
        bbr.on_ack(start + ms(2), start, 1_000_000, false, &rtt);
        bbr.on_ack(start + ms(3), start + ms(1), 1_000_000, false, &rtt);
        assert_eq!(bbr.max_bandwidth.get_estimate(), 1_000_000_000);
        assert_eq!(bbr.min_rtt, Duration::from_micros(20));
        assert_eq!(bbr.get_target_cwnd(1.0), 250_000);
    }

    // LORE: the window bounds in `calculate_cwnd` and `BbrConfig::max_window`.

    /// Runs a flow for `millis` ms: each millisecond one packet of as much of 500 KB as the window
    /// allows is sent, and the previous one is acked, a 1 ms round trip.
    fn run_flow(bbr: &mut Bbr, app_limited: bool, millis: u64) {
        let start = Instant::now();
        let mut rtt = estimator();
        let mut previous: Option<(Instant, u64, u64)> = None;
        for packet in 0..millis {
            let now = start + ms(packet);
            if let Some((sent, bytes, _)) = previous {
                bbr.on_ack(now, sent, bytes, app_limited, &rtt);
            }
            let bytes = bbr.window().min(500_000);
            bbr.on_sent(now, bytes, packet);
            if let Some((_, _, acked)) = previous {
                bbr.on_end_acks(now, bytes, app_limited, Some(acked));
                rtt.update(Duration::ZERO, ms(1), now);
            }
            previous = Some((now, bytes, packet));
        }
    }

    #[test]
    fn app_limited_flow_keeps_the_initial_window() {
        // A sender held back by flow control is app-limited on every ack, so it never has a
        // bandwidth estimate and never leaves STARTUP.
        let mut bbr = bbr();
        run_flow(&mut bbr, true, 10_000);
        assert_eq!(bbr.mode, Mode::Startup);
        assert_eq!(bbr.max_bandwidth.get_estimate(), 0);
        assert_eq!(bbr.window(), bbr.init_cwnd);
    }

    #[test]
    fn window_stops_at_max_window() {
        let mut config = BbrConfig::default();
        config.max_window(300_000);
        let mut bbr = Bbr::new(Arc::new(config), 1200);
        run_flow(&mut bbr, false, 3_000);
        assert_eq!(bbr.mode, Mode::ProbeBw);
        assert!(bbr.get_target_cwnd(bbr.cwnd_gain) > 300_000);
        assert_eq!(bbr.window(), 300_000);
    }

    fn bbr_with_max_window(max_window: u64) -> Bbr {
        let mut config = BbrConfig::default();
        config.max_window(max_window);
        Bbr::new(Arc::new(config), 1200)
    }

    #[test]
    fn initial_window_stops_at_max_window() {
        let bbr = bbr_with_max_window(100_000);
        assert!(bbr.init_cwnd > 100_000);
        assert_eq!(bbr.initial_window(), 100_000);
        assert_eq!(bbr.window(), 100_000);
    }

    #[test]
    fn max_window_below_one_packet_keeps_the_minimum_window() {
        let mut bbr = bbr_with_max_window(0);
        assert_eq!(bbr.initial_window(), bbr.min_cwnd);
        assert_eq!(bbr.window(), bbr.min_cwnd);
        run_flow(&mut bbr, false, 1_000);
        assert_eq!(bbr.window(), bbr.min_cwnd);
    }

    #[test]
    fn initial_window_below_one_packet_keeps_the_minimum_window() {
        let mut config = BbrConfig::default();
        config.initial_window(1);
        let bbr = Bbr::new(Arc::new(config.clone()), 1200);
        assert_eq!(bbr.initial_window(), bbr.min_cwnd);
        assert_eq!(bbr.window(), bbr.min_cwnd);
        config.max_window(0);
        let bbr = Bbr::new(Arc::new(config), 1200);
        assert_eq!(bbr.initial_window(), bbr.min_cwnd);
        assert_eq!(bbr.window(), bbr.min_cwnd);
    }

    #[test]
    fn probe_rtt_window_stops_at_max_window() {
        let start = Instant::now();
        let mut bbr = bbr_with_max_window(100_000);
        // 1 MB sent and acked per millisecond: 1 GB/s.
        bbr.on_sent(start, 1_000_000, 1);
        bbr.on_sent(start + ms(1), 1_000_000, 2);
        let mut rtt = estimator();
        rtt.update(Duration::ZERO, Duration::from_micros(20), start);
        bbr.on_ack(start + ms(2), start, 1_000_000, false, &rtt);
        bbr.on_ack(start + ms(3), start + ms(1), 1_000_000, false, &rtt);
        bbr.mode = Mode::ProbeRtt;
        assert!(bbr.get_probe_rtt_cwnd() > 100_000);
        assert_eq!(bbr.window(), 100_000);
    }
}
