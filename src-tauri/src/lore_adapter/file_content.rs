//! 文件内容的有界文本/二进制分类。
//!
//! 这里判断的是“内容是否适合文本 Diff”，不是“客户端是否拥有这种格式的专用预览器”。
//! 后者继续由 `asset_preview` 的受审计白名单负责，不能因为通用探测认为某份内容是二进制
//! 就自动把未知格式交给解析器。

use std::{
    fs::File,
    io::{self, Read},
    path::Path,
};

use serde::Serialize;

/// 单次分类最多读取的正文大小。
///
/// Status 可能包含成千上万个文件，因此采样预算必须是与文件总大小无关的常量。64 KiB
/// 足以覆盖常见 magic、BOM、文本编码与控制字符分布，同时不会把大型资产带入 IPC。
pub(super) const FILE_CONTENT_SAMPLE_LIMIT: usize = 64 * 1024;

/// 文件内容是否适合文本 Diff。
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileContentKind {
    Text,
    Binary,
    Unknown,
}

/// 分类结论所依据的证据。
///
/// 该字段帮助前端区分“已看到内容”和“列表阶段尚未读取内容”，也让诊断日志无需重新猜测
/// 为什么某个文件被分流。新增来源不会改变 `kind` 的稳定语义。
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileContentClassificationSource {
    Empty,
    Bom,
    Signature,
    Utf8,
    Utf16,
    ControlBytes,
    InvalidEncoding,
    Deferred,
    Unavailable,
    ChangedDuringRead,
}

/// 跨 IPC 使用的结构化内容分类。
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContentClassification {
    pub kind: FileContentKind,
    pub source: FileContentClassificationSource,
}

impl FileContentClassification {
    pub(super) const fn text(source: FileContentClassificationSource) -> Self {
        Self {
            kind: FileContentKind::Text,
            source,
        }
    }

    pub(super) const fn binary(source: FileContentClassificationSource) -> Self {
        Self {
            kind: FileContentKind::Binary,
            source,
        }
    }

    pub(super) const fn unknown(source: FileContentClassificationSource) -> Self {
        Self {
            kind: FileContentKind::Unknown,
            source,
        }
    }

    /// Revision Tree 与 Stage 列表没有安全的范围读取能力，必须显式表示“尚未探测”。
    pub(super) const fn deferred() -> Self {
        Self::unknown(FileContentClassificationSource::Deferred)
    }
}

/// 对工作区普通文件执行固定预算采样。
///
/// 调用方必须在进入这里前完成仓库相对路径、普通文件和符号链接越界校验。函数使用已经
/// 打开的句柄复核读取前后长度；若文件在采样期间缩放，则宁可返回 `unknown`，也不把来自
/// 两个时刻的状态拼成一个确定结论。
pub(super) fn classify_file_content(path: &Path) -> io::Result<FileContentClassification> {
    let mut file = File::open(path)?;
    let initial_size = file.metadata()?.len();
    if initial_size == 0 {
        return Ok(FileContentClassification::text(
            FileContentClassificationSource::Empty,
        ));
    }

    let requested = usize::try_from(initial_size.min(FILE_CONTENT_SAMPLE_LIMIT as u64))
        .expect("64 KiB sampling limit always fits usize");
    let mut sample = vec![0_u8; requested];
    let mut read = 0;
    while read < requested {
        match file.read(&mut sample[read..])? {
            0 => break,
            count => read += count,
        }
    }
    sample.truncate(read);

    let final_size = file.metadata()?.len();
    if final_size != initial_size || read != requested {
        return Ok(FileContentClassification::unknown(
            FileContentClassificationSource::ChangedDuringRead,
        ));
    }

    Ok(classify_content_sample(
        &sample,
        initial_size <= FILE_CONTENT_SAMPLE_LIMIT as u64,
    ))
}

/// 仅根据一份有界样本分类；`sample_complete` 表示样本是否覆盖完整文件。
pub(super) fn classify_content_sample(
    sample: &[u8],
    sample_complete: bool,
) -> FileContentClassification {
    if sample.is_empty() {
        return if sample_complete {
            FileContentClassification::text(FileContentClassificationSource::Empty)
        } else {
            FileContentClassification::unknown(FileContentClassificationSource::ChangedDuringRead)
        };
    }

    // UTF-32 BOM 必须先于 UTF-16 检查，因为 UTF-32LE 同样以 FF FE 开头。
    if sample.starts_with(&[0x00, 0x00, 0xfe, 0xff])
        || sample.starts_with(&[0xff, 0xfe, 0x00, 0x00])
        || sample.starts_with(&[0xfe, 0xff])
        || sample.starts_with(&[0xff, 0xfe])
        || sample.starts_with(&[0xef, 0xbb, 0xbf])
    {
        return FileContentClassification::text(FileContentClassificationSource::Bom);
    }

    // 少量稳定 magic 用于覆盖“头部本身是合法 ASCII”的二进制容器，例如 PDF、ZIP 和
    // Blender。其余格式仍由通用 NUL、控制字符和编码检查处理，不再维护扩展名全集。
    if has_known_binary_signature(sample) {
        return FileContentClassification::binary(FileContentClassificationSource::Signature);
    }

    // 无 BOM 的 UTF-16 ASCII/Latin 文本会呈现稳定的隔字节零分布。必须先识别它，否则
    // 通用 NUL 规则会把常见 Windows 文本错误归为二进制。
    if looks_like_utf16_without_bom(sample) {
        return FileContentClassification::text(FileContentClassificationSource::Utf16);
    }

    if sample.contains(&0) || has_excessive_control_bytes(sample) {
        return FileContentClassification::binary(FileContentClassificationSource::ControlBytes);
    }

    match std::str::from_utf8(sample) {
        Ok(_) => FileContentClassification::text(FileContentClassificationSource::Utf8),
        Err(error)
            if !sample_complete
                && error.error_len().is_none()
                && error.valid_up_to() > 0
                && std::str::from_utf8(&sample[..error.valid_up_to()]).is_ok() =>
        {
            // 固定采样可能正好截断最后一个 UTF-8 码点；有效前缀仍足以证明文本性质。
            FileContentClassification::text(FileContentClassificationSource::Utf8)
        }
        Err(_) => {
            FileContentClassification::unknown(FileContentClassificationSource::InvalidEncoding)
        }
    }
}

fn has_known_binary_signature(sample: &[u8]) -> bool {
    const SIGNATURES: &[&[u8]] = &[
        b"\x89PNG\r\n\x1a\n",
        b"\xff\xd8\xff",
        b"GIF87a",
        b"GIF89a",
        b"%PDF-",
        b"PK\x03\x04",
        b"PK\x05\x06",
        b"PK\x07\x08",
        b"7z\xbc\xaf\x27\x1c",
        b"Rar!\x1a\x07",
        b"\x7fELF",
        b"MZ",
        b"\0asm",
        b"SQLite format 3\0",
        b"RIFF",
        b"OggS",
        b"fLaC",
        b"BLENDER",
        b"Kaydara FBX Binary  \0",
        b"\xabKTX 20\xbb\r\n\x1a\n",
        b"DDS ",
        b"\x1f\x8b",
        b"BZh",
        b"\xfd7zXZ\0",
    ];

    SIGNATURES
        .iter()
        .any(|signature| sample.starts_with(signature))
}

fn looks_like_utf16_without_bom(sample: &[u8]) -> bool {
    let pair_count = sample.len() / 2;
    if pair_count < 4 {
        return false;
    }

    let mut even_zero = 0usize;
    let mut odd_zero = 0usize;
    let mut even_text = 0usize;
    let mut odd_text = 0usize;
    for pair in sample.chunks_exact(2) {
        even_zero += usize::from(pair[0] == 0);
        odd_zero += usize::from(pair[1] == 0);
        even_text += usize::from(is_ascii_text_byte(pair[0]));
        odd_text += usize::from(is_ascii_text_byte(pair[1]));
    }

    let dominant_threshold = pair_count * 3 / 4;
    let sparse_threshold = (pair_count / 20).max(1);
    let text_threshold = pair_count * 3 / 4;
    (odd_zero >= dominant_threshold && even_zero <= sparse_threshold && even_text >= text_threshold)
        || (even_zero >= dominant_threshold
            && odd_zero <= sparse_threshold
            && odd_text >= text_threshold)
}

fn is_ascii_text_byte(byte: u8) -> bool {
    byte.is_ascii_graphic() || matches!(byte, b' ' | b'\t' | b'\n' | b'\r')
}

fn has_excessive_control_bytes(sample: &[u8]) -> bool {
    let suspicious = sample
        .iter()
        .filter(|byte| {
            let byte = **byte;
            (byte < 0x20 && !matches!(byte, b'\t' | b'\n' | b'\r' | 0x0c)) || byte == 0x7f
        })
        .count();
    suspicious > 2 && suspicious.saturating_mul(100) > sample.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_utf8_text_without_an_extension_hint() {
        assert_eq!(
            classify_content_sample("自定义配置=true\n".as_bytes(), true),
            FileContentClassification::text(FileContentClassificationSource::Utf8)
        );
    }

    #[test]
    fn classifies_bom_and_bomless_utf16_as_text() {
        assert_eq!(
            classify_content_sample(&[0xff, 0xfe, b'a', 0, b'\n', 0], true).kind,
            FileContentKind::Text
        );
        assert_eq!(
            classify_content_sample(&[b'a', 0, b'b', 0, b'c', 0, b'\n', 0], true).source,
            FileContentClassificationSource::Utf16
        );
    }

    #[test]
    fn classifies_ascii_header_binary_formats_by_magic() {
        assert_eq!(
            classify_content_sample(b"%PDF-1.7\n1 0 obj", true),
            FileContentClassification::binary(FileContentClassificationSource::Signature)
        );
        assert_eq!(
            classify_content_sample(b"BLENDER-v300", true).kind,
            FileContentKind::Binary
        );
    }

    #[test]
    fn classifies_nul_and_dense_controls_as_binary() {
        assert_eq!(
            classify_content_sample(b"plain\0payload", true).kind,
            FileContentKind::Binary
        );
        assert_eq!(
            classify_content_sample(&[1, 2, 3, 4, b'a'], true).source,
            FileContentClassificationSource::ControlBytes
        );
    }

    #[test]
    fn leaves_unsupported_local_encoding_unknown() {
        assert_eq!(
            classify_content_sample(&[0xc4, 0xe3, 0xba, 0xc3], true),
            FileContentClassification::unknown(FileContentClassificationSource::InvalidEncoding)
        );
    }

    #[test]
    fn accepts_utf8_codepoint_truncated_only_by_sampling_boundary() {
        assert_eq!(
            classify_content_sample(&[b'a', b'b', 0xe4, 0xb8], false).kind,
            FileContentKind::Text
        );
        assert_eq!(
            classify_content_sample(&[b'a', b'b', 0xe4, 0xb8], true).kind,
            FileContentKind::Unknown
        );
    }
}
