use super::*;
use serde_json::json;

fn entry(revision: &str, number: u64, parents: &[&str]) -> Value {
    json!({"tagName":"revisionHistoryEntry", "data":{
        "revision":revision, "revisionNumber":number, "parent":parents
    }})
}

fn metadata(key: &str, value: Value) -> Value {
    json!({"tagName":"metadata", "data":{"key":key,"value":{"data":value}}})
}

fn operation(events: Vec<Value>) -> LoreOperationResult {
    LoreOperationResult {
        request_id: test_operation_context().request_id,
        workspace_key: None,
        operation: "revision.history",
        status: 0,
        duration_ms: 1,
        events,
    }
}

#[test]
fn history_dto_associates_metadata_once_and_keeps_author_facts() {
    let events = vec![
        metadata("message", json!("orphan must not attach")),
        entry("newer", 2, &["older"]),
        metadata("message", json!("first value")),
        metadata("message", json!("newer message")),
        metadata("created-by", json!("creator fallback")),
        metadata("committed-by", json!("user-42")),
        metadata("timestamp", json!(1_753_392_600)),
        entry("older", 1, &["0"]),
        metadata("created-by", json!("Artist <artist@example.com>")),
        metadata("timestamp", json!(1_743_724_799_999_u64)),
    ];
    let result = collect_revision_history_with(100, None, |_, _| Ok(operation(events.clone())))
        .expect("Valid history should produce application facts");
    assert_eq!(
        result.entries[0],
        LoreRevisionHistoryEntry {
            revision: "newer".to_owned(),
            revision_number: 2,
            parent_ids: vec!["older".to_owned()],
            message: "newer message".to_owned(),
            author_identity: "user-42".to_owned(),
            committed_at: Some(1_753_392_600_000),
        }
    );
    assert_eq!(
        result.entries[1],
        LoreRevisionHistoryEntry {
            revision: "older".to_owned(),
            revision_number: 1,
            parent_ids: vec![],
            message: String::new(),
            author_identity: "Artist <artist@example.com>".to_owned(),
            committed_at: Some(1_743_724_799_999),
        }
    );
    assert!(
        result.events.is_empty(),
        "History data must not also travel as raw events"
    );
}

#[test]
fn history_dto_distinguishes_empty_missing_and_fallback_authors() {
    for (committed, created, expected) in [
        (Some(json!("author")), Some(json!("creator")), "author"),
        (Some(json!("")), Some(json!("creator")), ""),
        (Some(Value::Null), Some(json!("creator")), "creator"),
        (None, Some(json!("creator")), "creator"),
        (None, None, ""),
    ] {
        let mut events = vec![entry("revision", 1, &[])];
        if let Some(value) = committed {
            events.push(metadata("committed-by", value));
        }
        if let Some(value) = created {
            events.push(metadata("created-by", value));
        }
        let groups = parse_revision_history_groups(&events, &mut 0).unwrap();
        assert_eq!(groups[0].entry.author_identity, expected);
    }
}

#[test]
fn history_dto_normalizes_timestamp_units_and_date_range() {
    for (raw, expected) in [
        (json!(1_753_392_600), Some(1_753_392_600_000_u64)),
        (json!(1_753_392_600_123_u64), Some(1_753_392_600_123)),
        (
            json!(8_640_000_000_000_000_u64),
            Some(8_640_000_000_000_000),
        ),
        (json!(8_640_000_000_000_001_u64), None),
        (json!(u64::MAX), None),
        (json!(0), None),
        (json!(-1), None),
        (json!(1.5), None),
        (json!("1753392600"), None),
        (Value::Null, None),
    ] {
        let groups = parse_revision_history_groups(
            &[
                entry("revision", 1, &[]),
                metadata("timestamp", raw.clone()),
            ],
            &mut 0,
        )
        .unwrap();
        assert_eq!(
            groups[0].entry.committed_at, expected,
            "Timestamp {raw} must have stable app semantics"
        );
    }
    let groups = parse_revision_history_groups(&[entry("revision", 1, &[])], &mut 0).unwrap();
    assert_eq!(groups[0].entry.committed_at, None);
}

#[test]
fn history_dto_normalizes_parents_without_reordering_the_first_parent() {
    let groups = parse_revision_history_groups(
        &[entry(
            "child",
            5,
            &[
                "z-first", "a-second", "", "0000", "child", "z-first", "a-second",
            ],
        )],
        &mut 0,
    )
    .unwrap();
    assert_eq!(groups[0].entry.parent_ids, vec!["z-first", "a-second"]);
}

#[test]
fn history_dto_rejects_invalid_revision_identities() {
    for revision in [
        Value::Null,
        json!(""),
        json!("  "),
        json!(" id "),
        json!("id with space"),
        json!("id\u{0000}"),
        json!("0000"),
        json!(12),
        json!(true),
    ] {
        let mut event = entry("valid", 1, &[]);
        event["data"]["revision"] = revision;
        let error = parse_revision_history_groups(&[event], &mut 0).unwrap_err();
        assert_eq!(error.code, "revision_history_invalid_identity");
    }
}

#[test]
fn history_dto_rejects_invalid_sequence_numbers_and_parent_shapes() {
    for number in [Value::Null, json!(-1), json!(1.5), json!("1")] {
        let mut event = entry("valid", 1, &[]);
        event["data"]["revisionNumber"] = number;
        assert_eq!(
            parse_revision_history_groups(&[event], &mut 0)
                .unwrap_err()
                .code,
            "invalid_revision_history_entry"
        );
    }
    for parents in [
        Value::Null,
        json!({}),
        json!([12]),
        json!([" bad "]),
        json!(["id\u{0000}"]),
    ] {
        let mut event = entry("valid", 1, &[]);
        event["data"]["parent"] = parents;
        assert_eq!(
            parse_revision_history_groups(&[event], &mut 0)
                .unwrap_err()
                .code,
            "invalid_revision_history_entry"
        );
    }
}

#[test]
fn history_primary_failure_retains_diagnostics_without_partial_entries() {
    let diagnostics = vec![
        json!({"tagName":"error","data":{"errorInner":"raw history detail"}}),
        json!({"tagName":"complete","data":{"status":401,"error":{
            "message":"The request does not have valid authentication credentials", "traceLocations":["native history"]
        }}}),
    ];
    let mut calls = 0;
    let result = collect_revision_history_with(100, None, |_, _| {
        calls += 1;
        let mut events = vec![
            entry("partial", 1, &["missing"]),
            metadata("message", json!("partial")),
        ];
        events.extend(diagnostics.clone());
        Ok(LoreOperationResult {
            request_id: test_operation_context().request_id,
            workspace_key: None,
            operation: "revision.history",
            status: 401,
            duration_ms: 7,
            events,
        })
    })
    .unwrap();
    assert_eq!(calls, 1);
    assert_eq!(result.operation, "revision.history");
    assert_eq!(result.status, 401);
    assert_eq!(result.duration_ms, 7);
    assert_eq!(result.events, diagnostics);
    assert!(result.entries.is_empty());
}

#[test]
fn history_dto_payload_contains_the_same_facts_without_protocol_envelopes() {
    let count = 1_000_u32;
    let mut events =
        vec![json!({"tagName":"revisionHistory","data":{"repository":"repo","branch":"main"}})];
    for number in (1..=count).rev() {
        events.push(entry(
            &format!("{number:064x}"),
            number.into(),
            &[&format!("{:064x}", number - 1)],
        ));
        events.push(metadata("message", json!(format!("Revision {number}"))));
        events.push(metadata(
            "committed-by",
            json!("Contributor <author@example.com>"),
        ));
        events.push(metadata(
            "timestamp",
            json!(1_753_392_600_000_u64 + u64::from(number)),
        ));
    }
    events.push(json!({"tagName":"complete","data":{"status":0}}));
    let previous_bytes = serde_json::to_vec(&operation(events.clone()))
        .unwrap()
        .len();
    let result =
        collect_revision_history_with(count, None, |_, _| Ok(operation(events.clone()))).unwrap();
    assert_eq!(result.entries.len(), count as usize);
    for (index, entry) in result.entries.iter().enumerate() {
        let number = count as usize - index;
        assert_eq!(entry.revision, format!("{number:064x}"));
        assert_eq!(entry.revision_number, number as u64);
        assert_eq!(entry.message, format!("Revision {number}"));
        assert_eq!(entry.author_identity, "Contributor <author@example.com>");
        assert_eq!(entry.committed_at, Some(1_753_392_600_000 + number as u64));
        assert_eq!(
            entry.parent_ids,
            if number > 1 {
                vec![format!("{:064x}", number - 1)]
            } else {
                vec![]
            }
        );
    }
    assert_eq!(
        result.events,
        vec![json!({"tagName":"complete","data":{"status":0}})]
    );
    let dto_bytes = serde_json::to_vec(&result).unwrap().len();
    assert!(dto_bytes < previous_bytes);
    println!(
        "history_payload entries={count} raw_events_bytes={previous_bytes} dto_bytes={dto_bytes}"
    );
}
