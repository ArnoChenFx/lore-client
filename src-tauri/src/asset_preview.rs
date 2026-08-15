//! 不可信游戏资产的只读结构化预览。
//!
//! 普通预览只处理已经通过仓库相对路径、符号链接和用户配置原始文件限制的内存字节；
//! 大型 Blender/Unreal 主包另走 `Read + Seek` 有界区间读取。所有解析器仍需自行限制
//! 目录项、路径长度、声明尺寸和递归深度，避免容器元数据触发过量分配。这里只读取目录、
//! 稳定头部和编辑器明确引用的缩略图；不会提取文件、执行脚本或追随外部资源。

use serde::Serialize;
use std::collections::BTreeMap;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::{Arc, OnceLock};

const MAX_DIRECTORY_ENTRIES: usize = 500;
const MAX_DECLARED_ENTRIES: usize = 100_000;
const MAX_PATH_BYTES: usize = 4_096;
const MAX_UNITY_BLOCK_INFO_BYTES: usize = 4 * 1024 * 1024;
const MAX_BLENDER_DECOMPRESSED_BYTES: usize = 64 * 1024 * 1024;
const MAX_EMBEDDED_THUMBNAIL_BYTES: usize = 16 * 1024 * 1024;
const MAX_EMBEDDED_THUMBNAIL_DIMENSION: u32 = 1_024;
/// SVG 是可声明任意画布尺寸的文本格式；栅格化单边上限把最终 RGBA 缓冲限制在 16 MiB。
const MAX_SVG_PREVIEW_DIMENSION: u32 = 512;
/// Unreal 版本化包摘要中的 CustomVersion 数组最长约 80 KiB；128 KiB 足以覆盖它、
/// FolderName 以及后续 512 字节候选窗口，同时不会随源资产体积增长。
const MAX_UNREAL_SUMMARY_PREFIX_BYTES: usize = 128 * 1024;
/// 64 个缩略图表项在最坏 UTF-16 名称长度下仍应落在该窗口内；超过时按无缩略图降级。
const MAX_UNREAL_THUMBNAIL_TABLE_BYTES: usize = 1024 * 1024;
const UNREAL_THUMBNAIL_TABLE_PROBE_BYTES: usize = 4 * 1024;
/// 4 KiB 探针固定成本且候选窗口最多 512 个字节位置（去重后候选数仍受其约束）；
/// 只有 1 MiB 扩大读取需要单独限流，防止恶意摘要用大量“像表项数”的假候选把
/// I/O 放大成数百 MiB。
const MAX_UNREAL_THUMBNAIL_TABLE_EXPANSIONS: usize = 16;
/// 缩略图对象正文的累计读取预算：多条表项可指向同一片大对象，恶意摘要可通过
/// 合法小表项把单文件读取放大成无界远端下载；预算耗尽即停止全部候选验证。
const MAX_UNREAL_THUMBNAIL_READ_BYTES: usize = 32 * 1024 * 1024;

/// 归档目录中可安全展示的一项；路径始终只是文本，不会用于文件系统访问。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePreviewEntry {
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
    pub compressed_size: Option<u64>,
}

/// 引擎资产稳定元数据中的一个语义字段。
///
/// `key` 只能取本模块定义的有限集合，前端据此选择当前语言标签；解析器不会把
/// 文件内任意字符串当作界面文案或字段名。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetMetadataFact {
    pub key: &'static str,
    pub value: String,
}

/// 不含可执行内容的结构化预览；`type` 是前端判别字段。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StructuredAssetPreview {
    Archive {
        format: String,
        total_entries: usize,
        truncated: bool,
        entries: Vec<ArchivePreviewEntry>,
        facts: Vec<AssetMetadataFact>,
        warning_codes: Vec<&'static str>,
    },
    AssetMetadata {
        format: String,
        facts: Vec<AssetMetadataFact>,
        warning_codes: Vec<&'static str>,
    },
}

/// 专有资产解析的一次性结果。
///
/// 元数据与缩略图必须在同一轮解析中产生，避免压缩 Blender 文件被重复解压，或
/// Unreal 包摘要被两套略有差异的游标逻辑分别解释。缩略图仍只在 Rust 边界内作为
/// RGBA 像素存在，进入 IPC 前会统一编码成 PNG。
struct ParsedAssetPreview {
    structured_preview: StructuredAssetPreview,
    thumbnail: Option<image::RgbaImage>,
}

impl ParsedAssetPreview {
    fn metadata_only(structured_preview: StructuredAssetPreview) -> Self {
        Self {
            structured_preview,
            thumbnail: None,
        }
    }
}

/// 完整文件预处理结果；Raw IPC 只消费这里经过约束的载荷。
pub struct PreparedFilePreviewPayload {
    pub mime_type: &'static str,
    pub data: Vec<u8>,
    pub structured_preview: Option<StructuredAssetPreview>,
}

/// 解析失败保持稳定错误码，最终由前端映射成多语言提示。
#[derive(Clone, Debug, PartialEq)]
pub struct AssetPreviewError {
    pub code: &'static str,
    pub message: String,
}

impl AssetPreviewError {
    fn invalid(format: &str, detail: impl Into<String>) -> Self {
        Self {
            code: "binary_preview_invalid_asset",
            message: format!("Invalid {format} preview data: {}", detail.into()),
        }
    }

    fn unsupported(format: &str, detail: impl Into<String>) -> Self {
        Self {
            code: "binary_preview_asset_variant_unsupported",
            message: format!("Unsupported {format} preview variant: {}", detail.into()),
        }
    }

    /// 纹理解码失败（DDS/TGA/TIFF/EXR 等）。
    pub(crate) fn decode_failed(detail: impl Into<String>) -> Self {
        Self {
            code: "binary_preview_decode_failed",
            message: detail.into(),
        }
    }

    /// PNG 重编码失败。
    fn encode_failed(detail: impl Into<String>) -> Self {
        Self {
            code: "binary_preview_encode_failed",
            message: detail.into(),
        }
    }

    /// 文件超过当前用户配置的内嵌预览限制。
    pub(crate) fn too_large(size: u64, limit_bytes: u64) -> Self {
        Self {
            code: "binary_preview_too_large",
            message: format!(
                "The file is {:.1} MiB, exceeding the {:.2} MiB embedded preview limit; \
                 open it with an external application",
                size as f64 / (1024.0 * 1024.0),
                limit_bytes as f64 / (1024.0 * 1024.0)
            ),
        }
    }

    /// 前端或偏好文件提交了零值、非有限值，或无法换算到字节计数器的技术溢出值。
    pub(crate) fn invalid_limit(limit_mib: f64) -> Self {
        Self {
            code: "binary_preview_limit_invalid",
            message: format!(
                "The binary preview limit must be at least {MIN_BINARY_PREVIEW_LIMIT_MIB} MiB \
                 and fit the byte counter; received {limit_mib} MiB"
            ),
        }
    }
}

/// 读取固定字节序整数的有界游标；任何越界都返回错误，不允许切片 panic。
struct ByteCursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> ByteCursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn with_position(bytes: &'a [u8], position: usize) -> Result<Self, AssetPreviewError> {
        if position > bytes.len() {
            return Err(AssetPreviewError::invalid(
                "asset",
                "offset exceeds file size",
            ));
        }
        Ok(Self { bytes, position })
    }

    fn position(&self) -> usize {
        self.position
    }

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.position)
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], AssetPreviewError> {
        let end = self
            .position
            .checked_add(length)
            .ok_or_else(|| AssetPreviewError::invalid("asset", "offset overflow"))?;
        if end > self.bytes.len() {
            return Err(AssetPreviewError::invalid(
                "asset",
                "declared data exceeds file size",
            ));
        }
        let result = &self.bytes[self.position..end];
        self.position = end;
        Ok(result)
    }

    fn skip(&mut self, length: usize) -> Result<(), AssetPreviewError> {
        self.take(length).map(|_| ())
    }

    fn align(&mut self, alignment: usize) -> Result<(), AssetPreviewError> {
        let aligned = self
            .position
            .checked_add(alignment.saturating_sub(1))
            .map(|value| value / alignment * alignment)
            .ok_or_else(|| AssetPreviewError::invalid("asset", "alignment overflow"))?;
        self.skip(aligned.saturating_sub(self.position))
    }

    fn u8(&mut self) -> Result<u8, AssetPreviewError> {
        Ok(self.take(1)?[0])
    }

    fn u32_le(&mut self) -> Result<u32, AssetPreviewError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn u32_be(&mut self) -> Result<u32, AssetPreviewError> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn i32_le(&mut self) -> Result<i32, AssetPreviewError> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn u64_le(&mut self) -> Result<u64, AssetPreviewError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn u64_be(&mut self) -> Result<u64, AssetPreviewError> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn c_string(&mut self, maximum: usize) -> Result<String, AssetPreviewError> {
        let searchable = self.remaining().min(maximum.saturating_add(1));
        let source = &self.bytes[self.position..self.position + searchable];
        let length = source
            .iter()
            .position(|byte| *byte == 0)
            .ok_or_else(|| AssetPreviewError::invalid("asset", "unterminated string"))?;
        let bytes = self.take(length)?;
        self.skip(1)?;
        Ok(String::from_utf8_lossy(bytes).into_owned())
    }
}

fn fact(key: &'static str, value: impl ToString) -> AssetMetadataFact {
    AssetMetadataFact {
        key,
        value: value.to_string(),
    }
}

fn archive(
    format: impl Into<String>,
    total_entries: usize,
    entries: Vec<ArchivePreviewEntry>,
    warning_codes: Vec<&'static str>,
) -> StructuredAssetPreview {
    StructuredAssetPreview::Archive {
        format: format.into(),
        total_entries,
        truncated: total_entries > entries.len(),
        entries,
        facts: Vec::new(),
        warning_codes,
    }
}

fn metadata(
    format: impl Into<String>,
    facts: Vec<AssetMetadataFact>,
    warning_codes: Vec<&'static str>,
) -> StructuredAssetPreview {
    StructuredAssetPreview::AssetMetadata {
        format: format.into(),
        facts,
        warning_codes,
    }
}

/// 选择解析器并同时保留可能存在的编辑器缩略图。
fn build_parsed_asset_preview(
    path: &Path,
    bytes: &[u8],
) -> Result<Option<ParsedAssetPreview>, AssetPreviewError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let preview = match extension.as_str() {
        "ktx2" => try_parse(parse_ktx2_metadata, bytes)?.map(ParsedAssetPreview::metadata_only),
        "zip" => try_parse(parse_zip_directory, bytes)?.map(ParsedAssetPreview::metadata_only),
        "pak" => try_parse(parse_pak, bytes)?.map(ParsedAssetPreview::metadata_only),
        "assetbundle" | "bundle" | "unity3d" => {
            try_parse(parse_unity_bundle, bytes)?.map(ParsedAssetPreview::metadata_only)
        }
        "pck" => try_parse(parse_godot_pck, bytes)?.map(ParsedAssetPreview::metadata_only),
        "uasset" | "umap" | "uexp" | "ubulk" => {
            try_parse_asset_with_ext(parse_unreal_asset, &extension, bytes)?
        }
        "assets" => {
            try_parse(parse_unity_serialized_file, bytes)?.map(ParsedAssetPreview::metadata_only)
        }
        "res" => try_parse(parse_godot_resource, bytes)?.map(ParsedAssetPreview::metadata_only),
        "blend" => try_parse_asset(parse_blender, bytes)?,
        _ => None,
    };
    Ok(preview)
}

/// 扩展名匹配但内容不合法（`binary_preview_invalid_asset`）时返回 `None`，
/// 其他错误继续传播。
fn try_parse(
    parser: fn(&[u8]) -> Result<StructuredAssetPreview, AssetPreviewError>,
    bytes: &[u8],
) -> Result<Option<StructuredAssetPreview>, AssetPreviewError> {
    match parser(bytes) {
        Ok(preview) => Ok(Some(preview)),
        Err(error) if error.code == "binary_preview_invalid_asset" => Ok(None),
        Err(error) => Err(error),
    }
}

/// 对会同时产生元数据与缩略图的解析器应用相同的 magic 不匹配降级规则。
fn try_parse_asset(
    parser: fn(&[u8]) -> Result<ParsedAssetPreview, AssetPreviewError>,
    bytes: &[u8],
) -> Result<Option<ParsedAssetPreview>, AssetPreviewError> {
    match parser(bytes) {
        Ok(preview) => Ok(Some(preview)),
        Err(error) if error.code == "binary_preview_invalid_asset" => Ok(None),
        Err(error) => Err(error),
    }
}

/// 与 `try_parse_asset` 相同，但解析器需要扩展名区分主包与伴随文件。
fn try_parse_asset_with_ext(
    parser: fn(&str, &[u8]) -> Result<ParsedAssetPreview, AssetPreviewError>,
    ext: &str,
    bytes: &[u8],
) -> Result<Option<ParsedAssetPreview>, AssetPreviewError> {
    match parser(ext, bytes) {
        Ok(preview) => Ok(Some(preview)),
        Err(error) if error.code == "binary_preview_invalid_asset" => Ok(None),
        Err(error) => Err(error),
    }
}

fn parse_ktx2_metadata(bytes: &[u8]) -> Result<StructuredAssetPreview, AssetPreviewError> {
    const IDENTIFIER: &[u8; 12] = b"\xABKTX 20\xBB\r\n\x1A\n";
    if bytes.len() < 48 || &bytes[..12] != IDENTIFIER {
        return Err(AssetPreviewError::invalid("KTX2", "identifier is missing"));
    }
    let mut cursor = ByteCursor::with_position(bytes, 12)?;
    let vk_format = cursor.u32_le()?;
    let type_size = cursor.u32_le()?;
    let width = cursor.u32_le()?;
    let height = cursor.u32_le()?;
    let depth = cursor.u32_le()?;
    let layers = cursor.u32_le()?;
    let faces = cursor.u32_le()?;
    let levels = cursor.u32_le()?;
    let supercompression = cursor.u32_le()?;
    if width == 0 || faces == 0 || !matches!(faces, 1 | 6) {
        return Err(AssetPreviewError::invalid(
            "KTX2",
            "invalid dimensions or face count",
        ));
    }
    const MAX_TEXTURE_DIMENSION: u32 = 8_192;
    // 按最坏的四字节 RGBA 估算，把基础层单份 GPU backing store 控制在约 256 MiB。
    const MAX_BASE_LEVEL_TEXELS: u64 = 64 * 1024 * 1024;
    let base_level_texels = [width, height.max(1), depth.max(1), layers.max(1), faces]
        .into_iter()
        .try_fold(1u64, |total, dimension| {
            total.checked_mul(u64::from(dimension))
        })
        .ok_or_else(|| AssetPreviewError::invalid("KTX2", "decoded texture dimensions overflow"))?;
    if width > MAX_TEXTURE_DIMENSION
        || height.max(1) > MAX_TEXTURE_DIMENSION
        || base_level_texels > MAX_BASE_LEVEL_TEXELS
    {
        return Err(AssetPreviewError::invalid(
            "KTX2",
            format!(
                "decoded texture footprint is too large: {}x{}x{} layers={} faces={faces}",
                width,
                height.max(1),
                depth.max(1),
                layers.max(1)
            ),
        ));
    }
    Ok(metadata(
        "KTX2",
        vec![
            fact("width", width),
            fact("height", height.max(1)),
            fact("depth", depth.max(1)),
            fact("layers", layers.max(1)),
            fact("faces", faces),
            fact("mipLevels", levels.max(1)),
            fact("format", vk_format),
            fact("typeSize", type_size),
            fact("compression", supercompression),
        ],
        Vec::new(),
    ))
}

fn parse_zip_directory(bytes: &[u8]) -> Result<StructuredAssetPreview, AssetPreviewError> {
    let mut archive_reader = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| AssetPreviewError::invalid("ZIP", error.to_string()))?;
    let total_entries = archive_reader.len();
    if total_entries > MAX_DECLARED_ENTRIES {
        return Err(AssetPreviewError::invalid(
            "ZIP",
            format!("entry count {total_entries} exceeds safety limit"),
        ));
    }
    let mut entries = Vec::with_capacity(total_entries.min(MAX_DIRECTORY_ENTRIES));
    for index in 0..total_entries.min(MAX_DIRECTORY_ENTRIES) {
        let file = archive_reader
            .by_index(index)
            .map_err(|error| AssetPreviewError::invalid("ZIP", error.to_string()))?;
        let path = file.name().chars().take(MAX_PATH_BYTES).collect::<String>();
        entries.push(ArchivePreviewEntry {
            path,
            kind: if file.is_dir() { "directory" } else { "file" },
            size: file.size(),
            compressed_size: Some(file.compressed_size()),
        });
    }
    Ok(archive("ZIP", total_entries, entries, Vec::new()))
}

fn parse_pak(bytes: &[u8]) -> Result<StructuredAssetPreview, AssetPreviewError> {
    if bytes.starts_with(b"PACK") {
        return parse_quake_pak(bytes);
    }
    // Unreal Pak 的魔数位于版本化尾部。索引编码随 Pak 版本、加密和路径哈希方案变化；
    // 这里只报告稳定尾部字段，避免把错误偏移解释成伪目录。
    const UNREAL_MAGIC: [u8; 4] = 0x5A6F12E1u32.to_le_bytes();
    let search_start = bytes.len().saturating_sub(512);
    let magic_offset = bytes[search_start..]
        .windows(4)
        .rposition(|window| window == UNREAL_MAGIC)
        .map(|offset| search_start + offset);
    if let Some(magic_offset) = magic_offset {
        let mut cursor = ByteCursor::with_position(bytes, magic_offset + 4)?;
        let version = cursor.i32_le()?;
        let index_offset = cursor.u64_le()?;
        let index_size = cursor.u64_le()?;
        let index_end = index_offset.checked_add(index_size).unwrap_or(u64::MAX);
        let range_valid = index_end <= bytes.len() as u64;
        return Ok(archive(
            "Unreal Pak",
            0,
            Vec::new(),
            vec![if range_valid {
                "unrealPakVersionedIndex"
            } else {
                "unrealPakInvalidIndex"
            }],
        )
        .with_archive_metadata(vec![
            fact("version", version),
            fact("indexOffset", index_offset),
            fact("indexSize", index_size),
        ]));
    }
    Err(AssetPreviewError::unsupported(
        "PAK",
        "only Quake PACK and recognizable Unreal Pak containers are supported",
    ))
}

/// Archive DTO 刻意保持紧凑；Unreal Pak 等无法安全列目录的格式把稳定字段折叠进
/// 警告之外没有合适位置，因此当前通过零条目 + 版本化索引警告表达降级。这个辅助
/// 方法保留调用结构，未来 DTO 增加 archive facts 时不会改动解析分支。
trait ArchiveMetadataExtension {
    fn with_archive_metadata(self, _facts: Vec<AssetMetadataFact>) -> Self;
}

impl ArchiveMetadataExtension for StructuredAssetPreview {
    fn with_archive_metadata(mut self, metadata_facts: Vec<AssetMetadataFact>) -> Self {
        if let StructuredAssetPreview::Archive { facts, .. } = &mut self {
            *facts = metadata_facts;
        }
        self
    }
}

fn parse_quake_pak(bytes: &[u8]) -> Result<StructuredAssetPreview, AssetPreviewError> {
    if bytes.len() < 12 {
        return Err(AssetPreviewError::invalid(
            "Quake PAK",
            "header is truncated",
        ));
    }
    let mut cursor = ByteCursor::with_position(bytes, 4)?;
    let directory_offset = cursor.u32_le()? as usize;
    let directory_size = cursor.u32_le()? as usize;
    if directory_size % 64 != 0 {
        return Err(AssetPreviewError::invalid(
            "Quake PAK",
            "directory size is not aligned to 64-byte entries",
        ));
    }
    let total_entries = directory_size / 64;
    if total_entries > MAX_DECLARED_ENTRIES {
        return Err(AssetPreviewError::invalid(
            "Quake PAK",
            "directory entry count exceeds safety limit",
        ));
    }
    let directory_end = directory_offset
        .checked_add(directory_size)
        .ok_or_else(|| AssetPreviewError::invalid("Quake PAK", "directory range overflow"))?;
    if directory_end > bytes.len() {
        return Err(AssetPreviewError::invalid(
            "Quake PAK",
            "directory exceeds file size",
        ));
    }
    let mut entries = Vec::with_capacity(total_entries.min(MAX_DIRECTORY_ENTRIES));
    let mut directory = ByteCursor::with_position(bytes, directory_offset)?;
    for _ in 0..total_entries {
        let raw_name = directory.take(56)?;
        let name_length = raw_name.iter().position(|value| *value == 0).unwrap_or(56);
        let file_offset = directory.u32_le()? as u64;
        let file_size = directory.u32_le()? as u64;
        let end = file_offset.checked_add(file_size).unwrap_or(u64::MAX);
        if end > bytes.len() as u64 {
            return Err(AssetPreviewError::invalid(
                "Quake PAK",
                "file entry exceeds container size",
            ));
        }
        if entries.len() < MAX_DIRECTORY_ENTRIES {
            entries.push(ArchivePreviewEntry {
                path: String::from_utf8_lossy(&raw_name[..name_length]).into_owned(),
                kind: "file",
                size: file_size,
                compressed_size: None,
            });
        }
    }
    Ok(archive("Quake PAK", total_entries, entries, Vec::new()))
}

fn parse_unity_bundle(bytes: &[u8]) -> Result<StructuredAssetPreview, AssetPreviewError> {
    let mut cursor = ByteCursor::new(bytes);
    let signature = cursor.c_string(32)?;
    if !matches!(signature.as_str(), "UnityFS" | "UnityRaw" | "UnityWeb") {
        return Err(AssetPreviewError::invalid(
            "Unity AssetBundle",
            "signature is not recognized",
        ));
    }
    let format_version = cursor.u32_be()?;
    let player_version = cursor.c_string(128)?;
    let engine_version = cursor.c_string(128)?;

    if signature != "UnityFS" {
        return Ok(archive(
            format!("{signature} AssetBundle"),
            0,
            Vec::new(),
            vec!["unityLegacyBundleDirectoryUnavailable"],
        ));
    }

    let declared_file_size = cursor.u64_be()?;
    let compressed_info_size = cursor.u32_be()? as usize;
    let uncompressed_info_size = cursor.u32_be()? as usize;
    let flags = cursor.u32_be()?;
    if compressed_info_size > bytes.len() || uncompressed_info_size > MAX_UNITY_BLOCK_INFO_BYTES {
        return Err(AssetPreviewError::invalid(
            "UnityFS",
            "block info exceeds preview safety limit",
        ));
    }
    if format_version >= 7 {
        cursor.align(16)?;
    }
    let info_at_end = flags & 0x80 != 0;
    let info_offset = if info_at_end {
        bytes
            .len()
            .checked_sub(compressed_info_size)
            .ok_or_else(|| AssetPreviewError::invalid("UnityFS", "block info offset underflow"))?
    } else {
        cursor.position()
    };
    let info_end = info_offset
        .checked_add(compressed_info_size)
        .ok_or_else(|| AssetPreviewError::invalid("UnityFS", "block info range overflow"))?;
    if info_end > bytes.len() {
        return Err(AssetPreviewError::invalid(
            "UnityFS",
            "block info exceeds file size",
        ));
    }

    let compression = flags & 0x3f;
    let info = match compression {
        0 => bytes[info_offset..info_end].to_vec(),
        2 | 3 => lz4_decompress_block(
            &bytes[info_offset..info_end],
            uncompressed_info_size,
            MAX_UNITY_BLOCK_INFO_BYTES,
        )?,
        1 => {
            return Ok(archive(
                "UnityFS AssetBundle",
                0,
                Vec::new(),
                vec!["unityLzmaDirectoryUnavailable"],
            ));
        }
        _ => {
            return Err(AssetPreviewError::unsupported(
                "UnityFS",
                format!("block info compression {compression}"),
            ));
        }
    };

    let (total_entries, entries) = parse_unity_block_info(&info)?;
    let mut warnings = Vec::new();
    if declared_file_size != 0 && declared_file_size != bytes.len() as u64 {
        warnings.push("unityDeclaredSizeMismatch");
    }
    if player_version.is_empty() || engine_version.is_empty() {
        warnings.push("unityVersionMetadataMissing");
    }
    Ok(archive(
        format!("UnityFS {engine_version}"),
        total_entries,
        entries,
        warnings,
    ))
}

fn parse_unity_block_info(
    info: &[u8],
) -> Result<(usize, Vec<ArchivePreviewEntry>), AssetPreviewError> {
    let mut cursor = ByteCursor::new(info);
    cursor.skip(16)?; // 数据块清单的 MD5；目录预览不用于完整性判定。
    let block_count = cursor.u32_be()? as usize;
    if block_count > MAX_DECLARED_ENTRIES {
        return Err(AssetPreviewError::invalid(
            "UnityFS",
            "block count exceeds safety limit",
        ));
    }
    cursor.skip(
        block_count
            .checked_mul(10)
            .ok_or_else(|| AssetPreviewError::invalid("UnityFS", "block table size overflow"))?,
    )?;
    let node_count = cursor.u32_be()? as usize;
    if node_count > MAX_DECLARED_ENTRIES {
        return Err(AssetPreviewError::invalid(
            "UnityFS",
            "directory entry count exceeds safety limit",
        ));
    }
    let mut entries = Vec::with_capacity(node_count.min(MAX_DIRECTORY_ENTRIES));
    for _ in 0..node_count {
        let _offset = cursor.u64_be()?;
        let size = cursor.u64_be()?;
        let _flags = cursor.u32_be()?;
        let path = cursor.c_string(MAX_PATH_BYTES)?;
        if entries.len() < MAX_DIRECTORY_ENTRIES {
            entries.push(ArchivePreviewEntry {
                path,
                kind: "file",
                size,
                compressed_size: None,
            });
        }
    }
    Ok((node_count, entries))
}

/// 只实现 UnityFS BlockInfo 所需的标准 LZ4 block 解码；输出长度必须与容器声明完全
/// 一致，并受 4 MiB 上限约束。任何偏移越界或重叠复制错误都会立即失败。
fn lz4_decompress_block(
    input: &[u8],
    output_size: usize,
    maximum_output: usize,
) -> Result<Vec<u8>, AssetPreviewError> {
    if output_size > maximum_output {
        return Err(AssetPreviewError::invalid(
            "LZ4",
            "declared output exceeds safety limit",
        ));
    }
    let mut output = Vec::with_capacity(output_size);
    let mut position = 0usize;
    while position < input.len() {
        let token = input[position];
        position += 1;
        let mut literal_length = (token >> 4) as usize;
        if literal_length == 15 {
            loop {
                let extension = *input.get(position).ok_or_else(|| {
                    AssetPreviewError::invalid("LZ4", "literal length is truncated")
                })?;
                position += 1;
                literal_length = literal_length
                    .checked_add(extension as usize)
                    .ok_or_else(|| AssetPreviewError::invalid("LZ4", "literal length overflow"))?;
                if extension != 255 {
                    break;
                }
            }
        }
        let literal_end = position
            .checked_add(literal_length)
            .ok_or_else(|| AssetPreviewError::invalid("LZ4", "literal range overflow"))?;
        if literal_end > input.len() || output.len() + literal_length > output_size {
            return Err(AssetPreviewError::invalid(
                "LZ4",
                "literal range exceeds input or output",
            ));
        }
        output.extend_from_slice(&input[position..literal_end]);
        position = literal_end;
        if position == input.len() {
            break;
        }
        let offset_bytes = input
            .get(position..position + 2)
            .ok_or_else(|| AssetPreviewError::invalid("LZ4", "match offset is truncated"))?;
        position += 2;
        let offset = u16::from_le_bytes(offset_bytes.try_into().unwrap()) as usize;
        if offset == 0 || offset > output.len() {
            return Err(AssetPreviewError::invalid("LZ4", "match offset is invalid"));
        }
        let mut match_length = (token & 0x0f) as usize + 4;
        if token & 0x0f == 15 {
            loop {
                let extension = *input.get(position).ok_or_else(|| {
                    AssetPreviewError::invalid("LZ4", "match length is truncated")
                })?;
                position += 1;
                match_length = match_length
                    .checked_add(extension as usize)
                    .ok_or_else(|| AssetPreviewError::invalid("LZ4", "match length overflow"))?;
                if extension != 255 {
                    break;
                }
            }
        }
        if output.len() + match_length > output_size {
            return Err(AssetPreviewError::invalid(
                "LZ4",
                "match exceeds declared output",
            ));
        }
        for _ in 0..match_length {
            let source = output.len() - offset;
            output.push(output[source]);
        }
    }
    if output.len() != output_size {
        return Err(AssetPreviewError::invalid(
            "LZ4",
            "decoded length does not match declaration",
        ));
    }
    Ok(output)
}

fn parse_godot_pck(bytes: &[u8]) -> Result<StructuredAssetPreview, AssetPreviewError> {
    if bytes.len() < 100 || &bytes[..4] != b"GDPC" {
        return Err(AssetPreviewError::invalid("Godot PCK", "header is missing"));
    }
    let mut cursor = ByteCursor::with_position(bytes, 4)?;
    let pack_version = cursor.u32_le()?;
    let engine_major = cursor.u32_le()?;
    let engine_minor = cursor.u32_le()?;
    let engine_patch = cursor.u32_le()?;
    let flags = cursor.u32_le()?;
    let file_base = cursor.u64_le()?;
    cursor.skip(16 * 4)?;
    let file_count = cursor.u32_le()? as usize;
    if file_count > MAX_DECLARED_ENTRIES {
        return Err(AssetPreviewError::invalid(
            "Godot PCK",
            "file count exceeds safety limit",
        ));
    }
    if flags & 1 != 0 {
        return Ok(archive(
            format!("Godot PCK {pack_version}"),
            file_count,
            Vec::new(),
            vec!["godotEncryptedDirectory"],
        ));
    }
    let mut entries = Vec::with_capacity(file_count.min(MAX_DIRECTORY_ENTRIES));
    for _ in 0..file_count {
        let path_length = cursor.u32_le()? as usize;
        if path_length > MAX_PATH_BYTES {
            return Err(AssetPreviewError::invalid(
                "Godot PCK",
                "path length exceeds safety limit",
            ));
        }
        let path_bytes = cursor.take(path_length)?;
        let path = String::from_utf8_lossy(path_bytes)
            .trim_end_matches('\0')
            .to_owned();
        let offset = cursor.u64_le()?;
        let size = cursor.u64_le()?;
        cursor.skip(16)?; // 文件 MD5。
        let _entry_flags = if pack_version >= 2 {
            cursor.u32_le()?
        } else {
            0
        };
        let absolute_offset = file_base.checked_add(offset).unwrap_or(u64::MAX);
        if absolute_offset.checked_add(size).unwrap_or(u64::MAX) > bytes.len() as u64 {
            return Err(AssetPreviewError::invalid(
                "Godot PCK",
                "file entry exceeds container size",
            ));
        }
        if entries.len() < MAX_DIRECTORY_ENTRIES {
            entries.push(ArchivePreviewEntry {
                path,
                kind: "file",
                size,
                compressed_size: None,
            });
        }
    }
    Ok(archive(
        format!("Godot PCK {engine_major}.{engine_minor}.{engine_patch}"),
        file_count,
        entries,
        Vec::new(),
    ))
}

fn parse_unreal_asset(
    extension: &str,
    bytes: &[u8],
) -> Result<ParsedAssetPreview, AssetPreviewError> {
    if matches!(extension, "uexp" | "ubulk") {
        return Ok(ParsedAssetPreview::metadata_only(metadata(
            format!("Unreal companion .{extension}"),
            vec![fact("fileSize", bytes.len())],
            vec!["unrealCompanionRequiresPackage"],
        )));
    }
    if bytes.len() < 20 {
        return Err(AssetPreviewError::invalid(
            "Unreal package",
            "summary is truncated",
        ));
    }
    let mut cursor = ByteCursor::new(bytes);
    let tag = cursor.u32_le()?;
    let byte_swapped = tag == 0xC1832A9E;
    if tag != 0x9E2A83C1 && !byte_swapped {
        return Err(AssetPreviewError::invalid(
            "Unreal package",
            "package tag is missing",
        ));
    }
    let legacy_version = if byte_swapped {
        i32::from_be_bytes(cursor.take(4)?.try_into().unwrap())
    } else {
        cursor.i32_le()?
    };
    let legacy_ue3_version = if byte_swapped {
        i32::from_be_bytes(cursor.take(4)?.try_into().unwrap())
    } else {
        cursor.i32_le()?
    };
    let thumbnail = if byte_swapped {
        None
    } else {
        unreal_summary_thumbnail(bytes)
    };
    let mut warning_codes = vec!["unrealVersionedSummaryOnly"];
    if thumbnail.is_none() {
        warning_codes.push("unrealEmbeddedThumbnailUnavailable");
    }
    Ok(ParsedAssetPreview {
        structured_preview: metadata(
            if extension == "umap" {
                "Unreal map package"
            } else {
                "Unreal asset package"
            },
            vec![
                fact("fileSize", bytes.len()),
                fact("legacyVersion", legacy_version),
                fact("legacyUe3Version", legacy_ue3_version),
                fact("endianness", if byte_swapped { "big" } else { "little" }),
            ],
            warning_codes,
        ),
        thumbnail,
    })
}

/// 读取 Unreal `FString`；正长度表示含尾零的 UTF-8 字节数，负长度表示 UTF-16LE
/// code unit 数。长度在读取和分配前受限，损坏包不能借此触发大内存分配。
fn read_unreal_fstring(
    cursor: &mut ByteCursor<'_>,
    maximum_units: i32,
) -> Result<String, AssetPreviewError> {
    let length = cursor.i32_le()?;
    if length == 0 {
        return Ok(String::new());
    }
    if length > 0 {
        if length > maximum_units {
            return Err(AssetPreviewError::invalid(
                "Unreal package",
                "FString length exceeds preview limit",
            ));
        }
        let bytes = cursor.take(length as usize)?;
        return Ok(String::from_utf8_lossy(bytes.strip_suffix(&[0]).unwrap_or(bytes)).into_owned());
    }

    let unit_count = length
        .checked_neg()
        .ok_or_else(|| AssetPreviewError::invalid("Unreal package", "FString length overflows"))?;
    if unit_count > maximum_units {
        return Err(AssetPreviewError::invalid(
            "Unreal package",
            "FString length exceeds preview limit",
        ));
    }
    let byte_count = (unit_count as usize).checked_mul(2).ok_or_else(|| {
        AssetPreviewError::invalid("Unreal package", "FString byte length overflows")
    })?;
    let bytes = cursor.take(byte_count)?;
    let mut units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    if units.last() == Some(&0) {
        units.pop();
    }
    Ok(String::from_utf16_lossy(&units))
}

/// 从版本化包摘要中寻找并验证 `ThumbnailTableOffset`。
///
/// UE 4.11 以后摘要前缀相对稳定，但尾部字段会随版本增删。这里只解析到 NameOffset，
/// 再在后续 512 字节的小窗口中探测候选 i32；候选必须完整通过缩略图表、字符串、
/// 文件偏移和 `FObjectThumbnail` 图像校验才会被接受。与全文件 magic scan 不同，
/// 该方法不会把资源正文中的任意 PNG/JPEG 冒充为编辑器缩略图。
fn unreal_summary_thumbnail(bytes: &[u8]) -> Option<image::RgbaImage> {
    let candidates = unreal_thumbnail_table_candidates(bytes, bytes.len() as u64)?;
    for candidate in candidates {
        let candidate = usize::try_from(candidate).ok()?;
        if let Some(thumbnail) = unreal_thumbnail_table(bytes, candidate) {
            return Some(thumbnail);
        }
    }
    None
}

/// 只从已读取的摘要前缀中提取可能的 `ThumbnailTableOffset`。
///
/// `file_size` 使用真实源文件大小校验绝对偏移，因此调用方可以只提供 128 KiB 前缀；
/// 候选仍必须在后续缩略图表和图片对象解析中完整通过验证，不能仅凭一个整数命中。
fn unreal_thumbnail_table_candidates(bytes: &[u8], file_size: u64) -> Option<Vec<u64>> {
    let mut cursor = ByteCursor::new(bytes);
    if cursor.u32_le().ok()? != 0x9E2A_83C1 {
        return None;
    }
    let legacy_version = cursor.i32_le().ok()?;
    if !(-12..=-6).contains(&legacy_version) {
        return None;
    }
    cursor.skip(4).ok()?; // LegacyUE3Version
    cursor.skip(4).ok()?; // FileVersionUE4
    if legacy_version <= -8 {
        cursor.skip(4).ok()?; // FileVersionUE5
    }
    cursor.skip(4).ok()?; // FileVersionLicenseeUE4
    if legacy_version <= -9 {
        cursor.skip(20).ok()?; // UE 5.5+ SavedHash (FIoHash)
        cursor.skip(4).ok()?; // UE 5.5+ 提前的 TotalHeaderSize
    }
    let custom_version_count = cursor.i32_le().ok()?;
    if !(0..=4_096).contains(&custom_version_count) {
        return None;
    }
    cursor
        .skip((custom_version_count as usize).checked_mul(20)?)
        .ok()?; // FGuid + i32
    if legacy_version > -9 {
        cursor.skip(4).ok()?; // UE 5.4 及更早位置的 TotalHeaderSize
    }
    read_unreal_fstring(&mut cursor, 4_096).ok()?; // FolderName / PackageName
    cursor.skip(4).ok()?; // PackageFlags
    cursor.skip(8).ok()?; // NameCount + NameOffset

    let start = cursor.position();
    let end = start
        .checked_add(512)?
        .min(bytes.len().saturating_sub(std::mem::size_of::<i32>()));
    let mut candidates = Vec::new();
    for position in start..end {
        let candidate = i32::from_le_bytes(bytes.get(position..position + 4)?.try_into().ok()?);
        if candidate <= 0 || candidate as u64 >= file_size {
            continue;
        }
        let candidate = candidate as u64;
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    Some(candidates)
}

/// 验证 Unreal 缩略图表并返回第一张能够安全解码的对象缩略图。
fn unreal_thumbnail_table(bytes: &[u8], offset: usize) -> Option<image::RgbaImage> {
    let thumbnail_offsets =
        unreal_thumbnail_offsets_from_table(bytes.get(offset..)?, bytes.len() as u64)?;
    thumbnail_offsets.into_iter().find_map(|thumbnail_offset| {
        usize::try_from(thumbnail_offset)
            .ok()
            .and_then(|thumbnail_offset| unreal_object_thumbnail(bytes, thumbnail_offset))
    })
}

/// 解析以表起点为零的有界缓冲，并保留其中声明的绝对对象偏移。
fn unreal_thumbnail_offsets_from_table(bytes: &[u8], file_size: u64) -> Option<Vec<u64>> {
    let mut cursor = ByteCursor::new(bytes);
    let entry_count = cursor.i32_le().ok()?;
    if !(1..=64).contains(&entry_count) {
        return None;
    }

    let mut thumbnail_offsets = Vec::with_capacity(entry_count as usize);
    for _ in 0..entry_count {
        let class_name = read_unreal_fstring(&mut cursor, 1_024).ok()?;
        if class_name.is_empty()
            || !class_name
                .chars()
                .all(|character| character.is_ascii_graphic())
        {
            return None;
        }
        read_unreal_fstring(&mut cursor, 4_096).ok()?; // ObjectPathWithoutPackageName
        let thumbnail_offset = cursor.i32_le().ok()?;
        if thumbnail_offset <= 0 || thumbnail_offset as u64 >= file_size {
            return None;
        }
        thumbnail_offsets.push(thumbnail_offset as u64);
    }
    Some(thumbnail_offsets)
}

/// 解析 `FObjectThumbnail` 的宽、高和压缩字节数组；负尺寸只携带压缩变体标记，
/// 因而在校验前取绝对值。压缩图像仍须通过明确的 PNG/JPEG magic 与解码限制。
fn unreal_object_thumbnail(bytes: &[u8], offset: usize) -> Option<image::RgbaImage> {
    let mut cursor = ByteCursor::with_position(bytes, offset).ok()?;
    let width = cursor.i32_le().ok()?.unsigned_abs();
    let height = cursor.i32_le().ok()?.unsigned_abs();
    let compressed_size = cursor.i32_le().ok()?;
    if width == 0 || height == 0 || width > 4_096 || height > 4_096 {
        return None;
    }
    if compressed_size <= 0 || compressed_size as usize > MAX_EMBEDDED_THUMBNAIL_BYTES {
        return None;
    }
    let compressed = cursor.take(compressed_size as usize).ok()?;
    decode_embedded_thumbnail(compressed)
}

/// 只解码 Unreal 缩略图表明确引用的 PNG/JPEG；最大边和总分配同时受限。
fn decode_embedded_thumbnail(bytes: &[u8]) -> Option<image::RgbaImage> {
    let format = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        image::ImageFormat::Png
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        image::ImageFormat::Jpeg
    } else {
        return None;
    };
    let mut limits = image_preview_limits();
    limits.max_image_width = Some(MAX_EMBEDDED_THUMBNAIL_DIMENSION);
    limits.max_image_height = Some(MAX_EMBEDDED_THUMBNAIL_DIMENSION);
    limits.max_alloc = Some(64 * 1024 * 1024);
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let decoded = reader.decode().ok()?.to_rgba8();
    if decoded.width().max(decoded.height()) > MAX_EMBEDDED_THUMBNAIL_DIMENSION {
        return None;
    }
    Some(decoded)
}

/// 从可定位读取器取得一个受限区间；结果长度永远不会超过调用方给定预算。
fn read_bounded_range(
    reader: &mut (impl Read + Seek),
    file_size: u64,
    offset: u64,
    maximum_length: usize,
) -> Result<Vec<u8>, AssetPreviewError> {
    if offset > file_size {
        return Err(AssetPreviewError::invalid(
            "asset",
            "bounded read offset exceeds file size",
        ));
    }
    let remaining = file_size.saturating_sub(offset);
    let length = remaining.min(maximum_length as u64) as usize;
    reader.seek(SeekFrom::Start(offset)).map_err(|error| {
        AssetPreviewError::invalid("asset", format!("bounded seek failed: {error}"))
    })?;
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).map_err(|error| {
        AssetPreviewError::invalid("asset", format!("bounded read failed: {error}"))
    })?;
    Ok(bytes)
}

/// 从可定位读取器取得精确区间；先用真实文件大小校验，避免损坏偏移触发越界 Seek。
fn read_exact_range(
    reader: &mut (impl Read + Seek),
    file_size: u64,
    offset: u64,
    length: usize,
) -> Result<Vec<u8>, AssetPreviewError> {
    let end = offset
        .checked_add(length as u64)
        .ok_or_else(|| AssetPreviewError::invalid("asset", "bounded range overflowed"))?;
    if end > file_size {
        return Err(AssetPreviewError::invalid(
            "asset",
            "bounded range exceeds file size",
        ));
    }
    read_bounded_range(reader, end, offset, length)
}

/// 从大型 Unreal 主包中按“摘要 → 缩略图表 → 图片对象”三段随机读取缩略图。
/// 任何候选都必须经过与完整内存解析相同的 FString、绝对偏移和图片解码校验。
fn parse_unreal_asset_from_reader(
    extension: &str,
    file_size: u64,
    reader: &mut (impl Read + Seek),
) -> Result<ParsedAssetPreview, AssetPreviewError> {
    let summary = read_bounded_range(reader, file_size, 0, MAX_UNREAL_SUMMARY_PREFIX_BYTES)?;
    if summary.len() < 20 {
        return Err(AssetPreviewError::invalid(
            "Unreal package",
            "summary is truncated",
        ));
    }

    let mut cursor = ByteCursor::new(&summary);
    let tag = cursor.u32_le()?;
    let byte_swapped = tag == 0xC1832A9E;
    if tag != 0x9E2A83C1 && !byte_swapped {
        return Err(AssetPreviewError::invalid(
            "Unreal package",
            "package tag is missing",
        ));
    }
    let legacy_version = if byte_swapped {
        i32::from_be_bytes(cursor.take(4)?.try_into().unwrap())
    } else {
        cursor.i32_le()?
    };
    let legacy_ue3_version = if byte_swapped {
        i32::from_be_bytes(cursor.take(4)?.try_into().unwrap())
    } else {
        cursor.i32_le()?
    };

    let mut thumbnail = None;
    if !byte_swapped {
        if let Some(table_offsets) = unreal_thumbnail_table_candidates(&summary, file_size) {
            // 缩略图表不只在包尾：UE 资产常把表放在摘要之后、名称表之前（如
            // TwinBlast 资产的偏移仅几千字节）。因此不能按偏移降序截断候选，
            // 必须与内存解析路径一样遍历全部候选，否则真实偏移被垃圾整数挤出
            // 验证名单。4 KiB 探针有固定窗口上界（512 个字节位置，去重后
            // 候选数仍受其约束）；昂贵的 1 MiB 扩大读取和对象正文读取分别设
            // 总次数与总字节上限，防止恶意摘要把远端叶片下载放大到无界。
            let mut expansions = 0;
            let mut object_bytes_read = 0usize;
            'tables: for table_offset in table_offsets {
                let table_probe = read_bounded_range(
                    reader,
                    file_size,
                    table_offset,
                    UNREAL_THUMBNAIL_TABLE_PROBE_BYTES,
                )?;
                let thumbnail_offsets =
                    unreal_thumbnail_offsets_from_table(&table_probe, file_size).or_else(|| {
                        let entry_count = table_probe
                            .get(..4)
                            .and_then(|bytes| bytes.try_into().ok())
                            .map(i32::from_le_bytes)?;
                        if !(1..=64).contains(&entry_count) {
                            return None;
                        }
                        // 只有首字段已经像真实表项数、但 4 KiB 不足时才扩大读取；
                        // 扩大次数有总上限，多数摘要整数候选在探针阶段即被淘汰。
                        if expansions >= MAX_UNREAL_THUMBNAIL_TABLE_EXPANSIONS {
                            return None;
                        }
                        expansions += 1;
                        let table = read_bounded_range(
                            reader,
                            file_size,
                            table_offset,
                            MAX_UNREAL_THUMBNAIL_TABLE_BYTES,
                        )
                        .ok()?;
                        unreal_thumbnail_offsets_from_table(&table, file_size)
                    });
                let Some(thumbnail_offsets) = thumbnail_offsets else {
                    continue;
                };
                for thumbnail_offset in thumbnail_offsets {
                    let Ok(object_header) =
                        read_exact_range(reader, file_size, thumbnail_offset, 12)
                    else {
                        continue;
                    };
                    let compressed_size =
                        i32::from_le_bytes(object_header[8..12].try_into().unwrap());
                    if compressed_size <= 0
                        || compressed_size as usize > MAX_EMBEDDED_THUMBNAIL_BYTES
                    {
                        continue;
                    }
                    let object_size =
                        12usize
                            .checked_add(compressed_size as usize)
                            .ok_or_else(|| {
                                AssetPreviewError::invalid(
                                    "Unreal package",
                                    "thumbnail object size overflowed",
                                )
                            })?;
                    // 多条表项可指向同一片大对象；累计预算耗尽即停止全部验证，
                    // 不让恶意摘要通过合法小表项把单文件读取放大成无界下载。
                    object_bytes_read = match object_bytes_read.checked_add(object_size) {
                        Some(total) if total <= MAX_UNREAL_THUMBNAIL_READ_BYTES => total,
                        _ => break 'tables,
                    };
                    let Ok(object) =
                        read_exact_range(reader, file_size, thumbnail_offset, object_size)
                    else {
                        continue;
                    };
                    if let Some(decoded) = unreal_object_thumbnail(&object, 0) {
                        thumbnail = Some(decoded);
                        break 'tables;
                    }
                }
            }
        }
    }

    let mut warning_codes = vec!["unrealVersionedSummaryOnly"];
    if thumbnail.is_none() {
        warning_codes.push("unrealEmbeddedThumbnailUnavailable");
    }
    Ok(ParsedAssetPreview {
        structured_preview: metadata(
            if extension == "umap" {
                "Unreal map package"
            } else {
                "Unreal asset package"
            },
            vec![
                fact("fileSize", file_size),
                fact("legacyVersion", legacy_version),
                fact("legacyUe3Version", legacy_ue3_version),
                fact("endianness", if byte_swapped { "big" } else { "little" }),
            ],
            warning_codes,
        ),
        thumbnail,
    })
}

fn parse_unity_serialized_file(bytes: &[u8]) -> Result<StructuredAssetPreview, AssetPreviewError> {
    if bytes.len() < 20 {
        return Err(AssetPreviewError::invalid(
            "Unity serialized file",
            "header is truncated",
        ));
    }
    let mut cursor = ByteCursor::new(bytes);
    let metadata_size = cursor.u32_be()? as u64;
    let mut declared_file_size = cursor.u32_be()? as u64;
    let version = cursor.u32_be()?;
    let mut data_offset = cursor.u32_be()? as u64;
    let endianness = if version >= 9 {
        let value = cursor.u8()?;
        cursor.skip(3)?;
        value
    } else {
        0
    };
    if version >= 22 {
        let _extended_metadata_size = cursor.u32_be()?;
        declared_file_size = cursor.u64_be()?;
        data_offset = cursor.u64_be()?;
        cursor.skip(8)?;
    }
    if declared_file_size > bytes.len() as u64 || data_offset > declared_file_size {
        return Err(AssetPreviewError::invalid(
            "Unity serialized file",
            "declared offsets exceed file size",
        ));
    }
    let engine_version = cursor.c_string(128).unwrap_or_default();
    let mut facts = vec![
        fact("formatVersion", version),
        fact("fileSize", declared_file_size),
        fact("metadataSize", metadata_size),
        fact("dataOffset", data_offset),
        fact("endianness", if endianness == 0 { "little" } else { "big" }),
    ];
    if !engine_version.is_empty() {
        facts.push(fact("engineVersion", engine_version));
    }
    Ok(metadata(
        "Unity serialized asset",
        facts,
        vec!["unityObjectTableVersionDependent"],
    ))
}

fn parse_godot_resource(bytes: &[u8]) -> Result<StructuredAssetPreview, AssetPreviewError> {
    if bytes.len() < 28 || &bytes[..4] != b"RSRC" {
        return Err(AssetPreviewError::invalid(
            "Godot binary resource",
            "RSRC header is missing",
        ));
    }
    let big_endian_flag = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
    let big_endian = big_endian_flag != 0;
    let read_u32 = |range: std::ops::Range<usize>| {
        let raw: [u8; 4] = bytes[range].try_into().unwrap();
        if big_endian {
            u32::from_be_bytes(raw)
        } else {
            u32::from_le_bytes(raw)
        }
    };
    let use_real64 = read_u32(8..12);
    let engine_major = read_u32(12..16);
    let engine_minor = read_u32(16..20);
    let format_version = read_u32(20..24);
    Ok(metadata(
        "Godot binary resource",
        vec![
            fact("engineVersion", format!("{engine_major}.{engine_minor}")),
            fact("formatVersion", format_version),
            fact(
                "floatingPoint",
                if use_real64 == 0 { "32-bit" } else { "64-bit" },
            ),
            fact("endianness", if big_endian { "big" } else { "little" }),
            fact("fileSize", bytes.len()),
        ],
        vec!["godotResourceHeaderOnly"],
    ))
}

fn parse_blender(bytes: &[u8]) -> Result<ParsedAssetPreview, AssetPreviewError> {
    // Blender 5 可以使用 zstd，旧版本也可能使用 gzip。两种压缩路径都只读取到
    // `MAX_BLENDER_DECOMPRESSED_BYTES + 1`，不能使用无界 decode_all/read_to_end。
    const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];
    const GZIP_MAGIC: [u8; 2] = [0x1F, 0x8B];
    if bytes.starts_with(&ZSTD_MAGIC) {
        let decoder = zstd::Decoder::new(Cursor::new(bytes)).map_err(|error| {
            AssetPreviewError::invalid("Blender", format!("zstd decompression failed: {error}"))
        })?;
        return parse_compressed_blender(decoder, bytes.len() as u64, "zstd");
    }
    if bytes.starts_with(&GZIP_MAGIC) {
        let decoder = flate2::read::GzDecoder::new(Cursor::new(bytes));
        return parse_compressed_blender(decoder, bytes.len() as u64, "gzip");
    }
    parse_uncompressed_blender(bytes)
}

/// 有界解压 Blender 文件，并把压缩方式加入稳定元数据。
fn parse_compressed_blender(
    decoder: impl Read,
    compressed_size: u64,
    compression: &'static str,
) -> Result<ParsedAssetPreview, AssetPreviewError> {
    let mut decompressed = Vec::new();
    decoder
        .take((MAX_BLENDER_DECOMPRESSED_BYTES + 1) as u64)
        .read_to_end(&mut decompressed)
        .map_err(|error| {
            AssetPreviewError::invalid(
                "Blender",
                format!("{compression} decompression failed: {error}"),
            )
        })?;
    if decompressed.len() > MAX_BLENDER_DECOMPRESSED_BYTES {
        return Ok(ParsedAssetPreview::metadata_only(metadata(
            "Blender",
            vec![
                fact("fileSize", compressed_size),
                fact("compression", compression),
            ],
            vec!["blenderMetadataDecompressionLimited"],
        )));
    }

    let mut parsed = parse_uncompressed_blender(&decompressed)?;
    if let StructuredAssetPreview::AssetMetadata { facts, .. } = &mut parsed.structured_preview {
        facts.push(fact("compression", compression));
    }
    Ok(parsed)
}

/// 大型 Blender 文件读取所需的稳定头部字段；块扫描器只依赖这些信息跳转。
struct BlenderSeekHeader {
    pointer_size: usize,
    little_endian: bool,
    version: String,
    blocks_start: u64,
    is_new_header: bool,
}

/// 解析 Blender 旧版 12 字节头和 5.x 17 字节头，不读取任何块正文。
fn parse_blender_seek_header(bytes: &[u8]) -> Result<BlenderSeekHeader, AssetPreviewError> {
    if bytes.len() < 12 || &bytes[..7] != b"BLENDER" {
        return Err(AssetPreviewError::invalid("Blender", "header is missing"));
    }
    let is_new_header = bytes.len() >= 17 && bytes[7].is_ascii_digit() && bytes[8].is_ascii_digit();
    if is_new_header {
        let header_len = ((bytes[7] - b'0') as usize) * 10 + ((bytes[8] - b'0') as usize);
        if bytes.len() < header_len || header_len < 17 {
            return Err(AssetPreviewError::invalid(
                "Blender",
                "new header is truncated",
            ));
        }
        let pointer_size = match bytes[9] {
            b'_' => 4,
            b'-' => 8,
            _ => {
                return Err(AssetPreviewError::invalid(
                    "Blender",
                    "pointer marker is invalid (new header)",
                ))
            }
        };
        let little_endian = match bytes[12] {
            b'v' => true,
            b'V' => false,
            _ => {
                return Err(AssetPreviewError::invalid(
                    "Blender",
                    "endian marker is invalid (new header)",
                ))
            }
        };
        return Ok(BlenderSeekHeader {
            pointer_size,
            little_endian,
            version: String::from_utf8_lossy(&bytes[13..17]).into_owned(),
            blocks_start: header_len as u64,
            is_new_header,
        });
    }

    let pointer_size = match bytes[7] {
        b'_' => 4,
        b'-' => 8,
        _ => {
            return Err(AssetPreviewError::invalid(
                "Blender",
                "pointer marker is invalid",
            ))
        }
    };
    let little_endian = match bytes[8] {
        b'v' => true,
        b'V' => false,
        _ => {
            return Err(AssetPreviewError::invalid(
                "Blender",
                "endian marker is invalid",
            ))
        }
    };
    Ok(BlenderSeekHeader {
        pointer_size,
        little_endian,
        version: String::from_utf8_lossy(&bytes[9..12]).into_owned(),
        blocks_start: 12,
        is_new_header,
    })
}

/// 扫描未压缩大型 Blender 文件时只读取块头；非 `TEST` 块通过 Seek 跳过正文。
fn parse_uncompressed_blender_from_reader(
    file_size: u64,
    reader: &mut (impl Read + Seek),
) -> Result<ParsedAssetPreview, AssetPreviewError> {
    let header_bytes = read_bounded_range(reader, file_size, 0, 17)?;
    let header = parse_blender_seek_header(&header_bytes)?;
    let block_header_size = if header.is_new_header {
        32usize
    } else {
        4 + 4 + header.pointer_size + 4 + 4
    };
    let mut position = header.blocks_start;
    let mut block_count = 0usize;
    let mut thumbnail = None;

    while position < file_size && block_count < MAX_DECLARED_ENTRIES {
        let block_header = read_exact_range(reader, file_size, position, block_header_size)?;
        let code: [u8; 4] = block_header[..4].try_into().unwrap();
        let data_size = if header.is_new_header {
            let raw: [u8; 8] = block_header[16..24].try_into().unwrap();
            let value = if header.little_endian {
                i64::from_le_bytes(raw)
            } else {
                i64::from_be_bytes(raw)
            };
            value.max(0) as u64
        } else {
            let raw: [u8; 4] = block_header[4..8].try_into().unwrap();
            if header.little_endian {
                u32::from_le_bytes(raw) as u64
            } else {
                u32::from_be_bytes(raw) as u64
            }
        };
        let body_start = position
            .checked_add(block_header_size as u64)
            .ok_or_else(|| AssetPreviewError::invalid("Blender", "block offset overflow"))?;
        let body_end = body_start
            .checked_add(data_size)
            .ok_or_else(|| AssetPreviewError::invalid("Blender", "block size overflow"))?;
        if body_end > file_size {
            return Err(AssetPreviewError::invalid(
                "Blender",
                "block data exceeds file size",
            ));
        }

        block_count += 1;
        if &code == b"TEST" && data_size <= (MAX_EMBEDDED_THUMBNAIL_BYTES + 8) as u64 {
            let body = read_exact_range(reader, file_size, body_start, data_size as usize)?;
            thumbnail = decode_blender_thumbnail_block(&body, header.little_endian);
        }
        if thumbnail.is_some() || &code == b"ENDB" {
            break;
        }
        position = body_end;
    }

    let warning_codes = if thumbnail.is_some() {
        Vec::new()
    } else {
        vec!["blenderEmbeddedThumbnailUnavailable"]
    };
    Ok(ParsedAssetPreview {
        structured_preview: metadata(
            "Blender",
            vec![
                fact("version", header.version),
                fact("pointerSize", header.pointer_size * 8),
                fact(
                    "endianness",
                    if header.little_endian {
                        "little"
                    } else {
                        "big"
                    },
                ),
                fact("fileSize", file_size),
                fact("headerVersion", if header.is_new_header { 1 } else { 0 }),
            ],
            warning_codes,
        ),
        thumbnail,
    })
}

/// 大型 Blender 入口：未压缩文件使用随机跳转；压缩文件只从源流解压既有 64 MiB 预算。
fn parse_blender_from_reader(
    file_size: u64,
    reader: &mut (impl Read + Seek),
) -> Result<ParsedAssetPreview, AssetPreviewError> {
    const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];
    const GZIP_MAGIC: [u8; 2] = [0x1F, 0x8B];
    let magic = read_bounded_range(reader, file_size, 0, 4)?;
    reader.seek(SeekFrom::Start(0)).map_err(|error| {
        AssetPreviewError::invalid("Blender", format!("source rewind failed: {error}"))
    })?;
    if magic.starts_with(&ZSTD_MAGIC) {
        let decoder = zstd::Decoder::new(reader).map_err(|error| {
            AssetPreviewError::invalid("Blender", format!("zstd decompression failed: {error}"))
        })?;
        return parse_compressed_blender(decoder, file_size, "zstd");
    }
    if magic.starts_with(&GZIP_MAGIC) {
        return parse_compressed_blender(flate2::read::GzDecoder::new(reader), file_size, "gzip");
    }
    parse_uncompressed_blender_from_reader(file_size, reader)
}

fn parse_uncompressed_blender(bytes: &[u8]) -> Result<ParsedAssetPreview, AssetPreviewError> {
    if bytes.len() < 12 || &bytes[..7] != b"BLENDER" {
        return Err(AssetPreviewError::invalid("Blender", "header is missing"));
    }

    // — 头部格式检测 —
    // Blender 5.0+ 引入 17 字节新头部：bytes[7..9] 是 ASCII 数字 "17"。
    // 旧格式（12 字节）：bytes[7] 是 '_'/'-'（指针标记），bytes[8] 是 'v'/'V'（字节序）。
    // 通过检查 bytes[7..9] 是否为 ASCII 数字来区分两种格式。
    let is_new_header = bytes.len() >= 17 && bytes[7].is_ascii_digit() && bytes[8].is_ascii_digit();

    let (pointer_size, little_endian, version, blocks_start) = if is_new_header {
        // 新头部布局 (17 字节)：
        //   [0..7)   "BLENDER"
        //   [7..9)   头部大小 ASCII (目前 "17")
        //   [9]      指针大小标记 ('_' = 4字节, '-' = 8字节)
        //   [10..12) 文件格式版本 ASCII (目前 "01")
        //   [12]     字节序 ('v' = LE, 'V' = BE)
        //   [13..17) Blender 版本 4 位 ASCII (如 "0502")
        let header_len = ((bytes[7] - b'0') as usize) * 10 + ((bytes[8] - b'0') as usize);
        if bytes.len() < header_len {
            return Err(AssetPreviewError::invalid(
                "Blender",
                "new header is truncated",
            ));
        }
        let ptr_size = match bytes[9] {
            b'_' => 4usize,
            b'-' => 8usize,
            _ => {
                return Err(AssetPreviewError::invalid(
                    "Blender",
                    "pointer marker is invalid (new header)",
                ))
            }
        };
        let le = match bytes[12] {
            b'v' => true,
            b'V' => false,
            _ => {
                return Err(AssetPreviewError::invalid(
                    "Blender",
                    "endian marker is invalid (new header)",
                ))
            }
        };
        let ver = String::from_utf8_lossy(&bytes[13..17]).into_owned();
        (ptr_size, le, ver, header_len)
    } else {
        // 旧头部布局 (12 字节)：
        //   [0..7)   "BLENDER"
        //   [7]      指针大小标记 ('_' = 4字节, '-' = 8字节)
        //   [8]      字节序 ('v' = LE, 'V' = BE)
        //   [9..12)  Blender 版本 3 位 ASCII (如 "279")
        if bytes.len() < 12 {
            return Err(AssetPreviewError::invalid(
                "Blender",
                "legacy header is truncated",
            ));
        }
        let ptr_size = match bytes[7] {
            b'_' => 4usize,
            b'-' => 8usize,
            _ => {
                return Err(AssetPreviewError::invalid(
                    "Blender",
                    "pointer marker is invalid",
                ))
            }
        };
        let le = match bytes[8] {
            b'v' => true,
            b'V' => false,
            _ => {
                return Err(AssetPreviewError::invalid(
                    "Blender",
                    "endian marker is invalid",
                ))
            }
        };
        let ver = String::from_utf8_lossy(&bytes[9..12]).into_owned();
        (ptr_size, le, ver, 12usize)
    };

    // — 块头解析 —
    // 新头部使用 LargeBHead8：code(4) + SDNAnr(4) + ptr(8) + len(8) + nr(8) = 32 字节。
    // 旧头部使用 BHead：      code(4) + len(4) + ptr(4|8) + SDNA(4) + nr(4) = 20|24 字节。
    let mut position = blocks_start;
    let mut block_count = 0usize;
    let mut counts: BTreeMap<&'static str, u64> = BTreeMap::new();
    let mut thumbnail = None;
    while position < bytes.len() && block_count < MAX_DECLARED_ENTRIES {
        // 最小块头 = 4（code）+ 4（最短整数字段）
        if position + 8 > bytes.len() {
            return Err(AssetPreviewError::invalid(
                "Blender",
                "block header is truncated",
            ));
        }
        let code = &bytes[position..position + 4];
        position += 4;

        let (data_size, element_count) = if is_new_header {
            // LargeBHead8：SDNAnr(4) + ptr(8) + len(8) + nr(8)
            let block_remainder = 4 + 8 + 8 + 8;
            if position + block_remainder > bytes.len() {
                return Err(AssetPreviewError::invalid(
                    "Blender",
                    "LargeBHead8 block is truncated",
                ));
            }
            // 跳过 SDNAnr (4 字节) 和 old pointer (8 字节)
            position += 4 + 8;
            let raw_len: [u8; 8] = bytes[position..position + 8].try_into().unwrap();
            let len = if little_endian {
                i64::from_le_bytes(raw_len)
            } else {
                i64::from_be_bytes(raw_len)
            };
            position += 8;
            let raw_nr: [u8; 8] = bytes[position..position + 8].try_into().unwrap();
            let nr = if little_endian {
                i64::from_le_bytes(raw_nr)
            } else {
                i64::from_be_bytes(raw_nr)
            };
            position += 8;
            (len.max(0) as usize, nr.max(0) as u64)
        } else {
            // BHead：len(4) + ptr(4|8) + SDNAnr(4) + nr(4)
            let block_remainder = 4 + pointer_size + 4 + 4;
            if position + block_remainder > bytes.len() {
                return Err(AssetPreviewError::invalid(
                    "Blender",
                    "block header is truncated",
                ));
            }
            let raw_size: [u8; 4] = bytes[position..position + 4].try_into().unwrap();
            let size = if little_endian {
                u32::from_le_bytes(raw_size)
            } else {
                u32::from_be_bytes(raw_size)
            } as usize;
            position += 4 + pointer_size + 4;
            let raw_nr: [u8; 4] = bytes[position..position + 4].try_into().unwrap();
            let nr = if little_endian {
                u32::from_le_bytes(raw_nr)
            } else {
                u32::from_be_bytes(raw_nr)
            } as u64;
            position += 4;
            (size, nr)
        };

        let body_end = position
            .checked_add(data_size)
            .ok_or_else(|| AssetPreviewError::invalid("Blender", "block size overflow"))?;
        if body_end > bytes.len() {
            return Err(AssetPreviewError::invalid(
                "Blender",
                "block data exceeds file size",
            ));
        }

        block_count += 1;
        let semantic_key = match &code[..2] {
            b"OB" => Some("objectCount"),
            b"ME" => Some("meshCount"),
            b"MA" => Some("materialCount"),
            b"IM" => Some("imageCount"),
            b"SC" => Some("sceneCount"),
            b"AC" => Some("actionCount"),
            b"AR" => Some("armatureCount"),
            _ => None,
        };
        if let Some(key) = semantic_key {
            *counts.entry(key).or_default() += element_count.max(1);
        }
        if code == b"TEST" && thumbnail.is_none() {
            thumbnail = decode_blender_thumbnail_block(&bytes[position..body_end], little_endian);
        }
        if code == b"ENDB" {
            break;
        }
        position = body_end;
    }
    let mut facts = vec![
        fact("version", version),
        fact("pointerSize", pointer_size * 8),
        fact("endianness", if little_endian { "little" } else { "big" }),
        fact("blockCount", block_count),
        fact("fileSize", bytes.len()),
        fact("headerVersion", if is_new_header { 1 } else { 0 }),
    ];
    facts.extend(counts.into_iter().map(|(key, value)| fact(key, value)));
    let warning_codes = if thumbnail.is_some() {
        Vec::new()
    } else {
        vec!["blenderEmbeddedThumbnailUnavailable"]
    };
    Ok(ParsedAssetPreview {
        structured_preview: metadata("Blender", facts, warning_codes),
        thumbnail,
    })
}

/// 解码 Blender `TEST` 块：`u32 width + u32 height + RGBA8`，像素行按 OpenGL
/// 约定自下而上存储。尺寸与乘法必须在分配前校验；无效 `TEST` 块只表示缩略图不可用，
/// 不影响同一文件中已经成功解析的对象计数等元数据。
fn decode_blender_thumbnail_block(body: &[u8], little_endian: bool) -> Option<image::RgbaImage> {
    if body.len() < 8 {
        return None;
    }
    let read_u32 = |bytes: &[u8]| {
        let raw: [u8; 4] = bytes.try_into().ok()?;
        Some(if little_endian {
            u32::from_le_bytes(raw)
        } else {
            u32::from_be_bytes(raw)
        })
    };
    let width = read_u32(&body[..4])?;
    let height = read_u32(&body[4..8])?;
    if width == 0
        || height == 0
        || width > MAX_EMBEDDED_THUMBNAIL_DIMENSION
        || height > MAX_EMBEDDED_THUMBNAIL_DIMENSION
    {
        return None;
    }
    let pixel_count = (width as usize).checked_mul(height as usize)?;
    let pixel_bytes = pixel_count.checked_mul(4)?;
    let required = 8usize.checked_add(pixel_bytes)?;
    if required > body.len() || pixel_bytes > MAX_EMBEDDED_THUMBNAIL_BYTES {
        return None;
    }

    let source = &body[8..required];
    let row_bytes = (width as usize).checked_mul(4)?;
    let mut rgba = Vec::with_capacity(pixel_bytes);
    for row in (0..height as usize).rev() {
        let start = row.checked_mul(row_bytes)?;
        rgba.extend_from_slice(source.get(start..start + row_bytes)?);
    }
    image::RgbaImage::from_raw(width, height, rgba)
}

// ─── 纹理预览载荷 ───────────────────────────────────────────────
// 以下函数负责把浏览器无法直接显示的纹理格式转码为 PNG；
// 模型、已支持图片和非图像资产原样透传。

/// 按扩展名返回 `(kind, mime_type)`，不匹配返回 `None`。
pub fn binary_preview_format(path: &Path) -> Option<(&'static str, &'static str)> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some(("image", "image/png")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "gif" => Some(("image", "image/gif")),
        "webp" => Some(("image", "image/webp")),
        "bmp" => Some(("image", "image/bmp")),
        "ico" => Some(("image", "image/x-icon")),
        // 源 MIME 仅作识别；实际 IPC 载荷会转成 image/png。
        "tga" => Some(("image", "image/x-tga")),
        "tif" | "tiff" => Some(("image", "image/tiff")),
        "dds" => Some(("image", "image/vnd-ms.dds")),
        "exr" => Some(("image", "image/x-exr")),
        "ktx2" => Some(("texture", "image/ktx2")),
        "pdf" => Some(("pdf", "application/pdf")),
        "obj" => Some(("model", "model/obj")),
        "fbx" => Some(("model", "model/fbx")),
        "gltf" => Some(("model", "model/gltf+json")),
        "glb" => Some(("model", "model/gltf-binary")),
        "csv" => Some(("csv", "text/csv")),
        // 源 MIME 只用于识别；原始 SVG 会在 Rust 边界拒绝资源引用并转成 PNG。
        "svg" => Some(("image", "image/svg+xml")),
        "wav" => Some(("audio", "audio/wav")),
        "ogg" => Some(("audio", "audio/ogg")),
        "mp3" => Some(("audio", "audio/mpeg")),
        "flac" => Some(("audio", "audio/flac")),
        "zip" => Some(("archive", "application/zip")),
        "pak" => Some(("archive", "application/x-pak")),
        "assetbundle" | "bundle" | "unity3d" => {
            Some(("archive", "application/x-unity-assetbundle"))
        }
        "pck" => Some(("archive", "application/x-godot-pck")),
        "ttf" => Some(("font", "font/ttf")),
        "otf" => Some(("font", "font/otf")),
        "uasset" | "umap" | "uexp" | "ubulk" => Some(("asset", "application/x-unreal-asset")),
        "assets" => Some(("asset", "application/x-unity-serialized-file")),
        "res" => Some(("asset", "application/x-godot-resource")),
        "blend" => Some(("asset", "application/x-blender")),
        _ => None,
    }
}

/// 预览偏好的产品默认值与最小值；产品不设置最大值。
///
/// 使用 f64 支持小于 1 MiB 的区间缩略图调试场景（如 0.01 MiB ≈ 10 KiB）。
pub const DEFAULT_BINARY_PREVIEW_LIMIT_MIB: f64 = 20.0;
pub const MIN_BINARY_PREVIEW_LIMIT_MIB: f64 = 0.01;

/// 把 MiB 转成字节；产品不设最大值，只拒绝零值、非有限值与 u64 技术溢出。
///
/// 小数 MiB 按向下取整换算，保证“不超过用户声明的上限”这一安全语义。
pub fn binary_preview_limit_bytes(limit_mib: f64) -> Result<u64, AssetPreviewError> {
    if !limit_mib.is_finite() || limit_mib < MIN_BINARY_PREVIEW_LIMIT_MIB {
        return Err(AssetPreviewError::invalid_limit(limit_mib));
    }
    let bytes = limit_mib * (1024.0 * 1024.0);
    if bytes > u64::MAX as f64 {
        return Err(AssetPreviewError::invalid_limit(limit_mib));
    }
    Ok(bytes.floor() as u64)
}

/// 判断原始资产是否超过当前完整正文内嵌预览上限。
///
/// 调用方可在真正读取内容前用它返回轻量大小元数据，或转入受支持资产的有界缩略图
/// 读取，避免为了显示预览而把整份资产载入内存。完整读取后仍须二次检查并发增长。
pub fn binary_preview_size_exceeded(size: u64, limit_bytes: u64) -> bool {
    size > limit_bytes
}

/// 同时在读取前后检查体积，避免损坏元数据或并发文件增长绕过 IPC 上限。
pub fn ensure_binary_preview_size(size: u64, limit_bytes: u64) -> Result<(), AssetPreviewError> {
    if binary_preview_size_exceeded(size, limit_bytes) {
        return Err(AssetPreviewError::too_large(size, limit_bytes));
    }
    Ok(())
}

/// 只有能够从稳定内部索引定位缩略图的主资产格式才允许绕过完整正文上限。
pub fn supports_large_embedded_thumbnail(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "blend" | "uasset" | "umap"
    )
}

/// 从可定位源中按需准备大型专有资产预览。
///
/// 该入口不接收完整 `Vec<u8>`：Unreal 最多读取摘要、1 MiB 表窗口和 16 MiB 图片对象；
/// 未压缩 Blender 只读取文件头、块头与 `TEST` 块。最终仍只向 IPC 返回 PNG 与元数据。
pub fn prepare_large_asset_preview_payload(
    path: &Path,
    file_size: u64,
    reader: &mut (impl Read + Seek),
) -> Result<PreparedFilePreviewPayload, AssetPreviewError> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let source_mime_type = match extension.as_str() {
        "blend" => "application/x-blender",
        "uasset" | "umap" => "application/x-unreal-asset",
        _ => {
            return Err(AssetPreviewError::unsupported(
                "large asset",
                "the format has no bounded embedded-thumbnail reader",
            ))
        }
    };
    let parsed = match extension.as_str() {
        "blend" => parse_blender_from_reader(file_size, reader)?,
        "uasset" | "umap" => parse_unreal_asset_from_reader(&extension, file_size, reader)?,
        _ => unreachable!(),
    };

    if let Some(thumbnail) = parsed.thumbnail {
        let (mime_type, data) =
            encode_texture_preview_png(image::DynamicImage::ImageRgba8(thumbnail))?;
        return Ok(PreparedFilePreviewPayload {
            mime_type,
            data,
            structured_preview: Some(parsed.structured_preview),
        });
    }
    Ok(PreparedFilePreviewPayload {
        mime_type: source_mime_type,
        data: Vec::new(),
        structured_preview: Some(parsed.structured_preview),
    })
}

/// 一次性完成结构化资产解析、内嵌缩略图提取和普通媒体预处理。
///
/// `.blend` 与 Unreal 主包若存在编辑器缩略图，`data` 只包含重编码后的 PNG；若没有
/// 缩略图则保持空载荷并继续返回结构化元数据。这样 WebView 不会收到随后被界面忽略的
/// 整份专有资产，同时工作区与 Revision 仍复用完全相同的稳定 DTO。
pub fn prepare_file_preview_payload(
    path: &Path,
    kind: &'static str,
    source_mime_type: &'static str,
    bytes: Vec<u8>,
) -> Result<PreparedFilePreviewPayload, AssetPreviewError> {
    let parsed_asset = build_parsed_asset_preview(path, &bytes)?;
    if let Some(parsed_asset) = parsed_asset {
        if let Some(thumbnail) = parsed_asset.thumbnail {
            let (mime_type, data) =
                encode_texture_preview_png(image::DynamicImage::ImageRgba8(thumbnail))?;
            return Ok(PreparedFilePreviewPayload {
                mime_type,
                data,
                structured_preview: Some(parsed_asset.structured_preview),
            });
        }

        if kind == "asset" {
            return Ok(PreparedFilePreviewPayload {
                mime_type: source_mime_type,
                data: Vec::new(),
                structured_preview: Some(parsed_asset.structured_preview),
            });
        }

        let (mime_type, data) = prepare_preview_payload(path, kind, source_mime_type, bytes)?;
        return Ok(PreparedFilePreviewPayload {
            mime_type,
            data,
            structured_preview: Some(parsed_asset.structured_preview),
        });
    }

    if kind == "asset" {
        return Ok(PreparedFilePreviewPayload {
            mime_type: source_mime_type,
            data: Vec::new(),
            structured_preview: None,
        });
    }
    let (mime_type, data) = prepare_preview_payload(path, kind, source_mime_type, bytes)?;
    Ok(PreparedFilePreviewPayload {
        mime_type,
        data,
        structured_preview: None,
    })
}

/// 浏览器无法直接显示的纹理在边界转成 PNG；模型与已支持图片原样透传。
pub fn prepare_preview_payload(
    path: &Path,
    kind: &'static str,
    mime_type: &'static str,
    mut bytes: Vec<u8>,
) -> Result<(&'static str, Vec<u8>), AssetPreviewError> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension == "svg" && kind == "image" {
        return rasterize_svg_preview(&bytes);
    }
    let source_format = match extension.as_str() {
        "tga" if kind == "image" => Some(image::ImageFormat::Tga),
        "tif" | "tiff" if kind == "image" => Some(image::ImageFormat::Tiff),
        "exr" if kind == "image" => Some(image::ImageFormat::OpenExr),
        _ => None,
    };
    if extension == "dds" && kind == "image" {
        use image::ImageDecoder as _;

        let mut decoder =
            image::codecs::dds::DdsDecoder::new(Cursor::new(bytes)).map_err(|error| {
                AssetPreviewError::decode_failed(format!(
                    "Failed to decode DDS texture preview: {error}"
                ))
            })?;
        decoder
            .set_limits(image_preview_limits())
            .map_err(|error| AssetPreviewError::decode_failed(error.to_string()))?;
        let image = image::DynamicImage::from_decoder(decoder).map_err(|error| {
            AssetPreviewError::decode_failed(format!(
                "Failed to decode DDS texture preview: {error}"
            ))
        })?;
        return encode_texture_preview_png(image);
    }
    let Some(source_format) = source_format else {
        return Ok((mime_type, bytes));
    };

    if source_format == image::ImageFormat::Tga {
        normalize_tga_preview_header(&mut bytes);
    }

    // 为 EXR 回退保留原始字节副本（image crate 会取得 Cursor 所有权）。
    let exr_fallback = if source_format == image::ImageFormat::OpenExr {
        Some(bytes.clone())
    } else {
        None
    };

    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), source_format);
    reader.limits(image_preview_limits());
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown file")
        .to_owned();
    let mut image = match reader.decode() {
        Ok(img) => img,
        Err(error) => {
            // image crate 的 EXR 解码器不支持单通道 Y（亮度）图像；
            // 退回到 exr crate 直接读取并将 Y 复制到 RGB。
            if source_format == image::ImageFormat::OpenExr
                && error.to_string().contains("non-deep rgb channels")
            {
                decode_exr_single_channel(exr_fallback.as_deref().unwrap_or_default(), &file_name)?
            } else {
                return Err(AssetPreviewError::decode_failed(format!(
                    "Failed to decode texture preview {file_name}: {error}"
                )));
            }
        }
    };
    if source_format == image::ImageFormat::OpenExr {
        // EXR 是线性 HDR；Reinhard 映射加 sRGB Gamma 能在普通 Diff 画布中保留高光层次，
        // 避免直接截断到 8 位后整片过曝。Alpha 单独钳制，不参与色调映射。
        // 消费 DynamicImage，若解码器已经返回 Rgba32F 就直接复用其像素缓冲，避免克隆。
        let source = image.into_rgba32f();
        let mapped = image::RgbaImage::from_fn(source.width(), source.height(), |x, y| {
            let pixel = source.get_pixel(x, y).0;
            let map = |value: f32| {
                let linear = value.max(0.0);
                let tone_mapped = linear / (1.0 + linear);
                (tone_mapped.powf(1.0 / 2.2) * 255.0)
                    .round()
                    .clamp(0.0, 255.0) as u8
            };
            image::Rgba([
                map(pixel[0]),
                map(pixel[1]),
                map(pixel[2]),
                (pixel[3] * 255.0).round().clamp(0.0, 255.0) as u8,
            ])
        });
        image = image::DynamicImage::ImageRgba8(mapped);
    }
    encode_texture_preview_png(image)
}

/// 把不可信 SVG 栅格化成有界 PNG。
///
/// usvg 的默认字符串解析器会把 href 当成本地路径读取，因此这里必须同时拒绝字符串
/// 与 data URL 资源；脚本、链接和事件属性不会进入渲染树。最终 WebView 只收到 PNG。
fn rasterize_svg_preview(bytes: &[u8]) -> Result<(&'static str, Vec<u8>), AssetPreviewError> {
    static FONT_DATABASE: OnceLock<Arc<resvg::usvg::fontdb::Database>> = OnceLock::new();

    let mut options = resvg::usvg::Options::default();
    options.image_href_resolver = resvg::usvg::ImageHrefResolver {
        resolve_data: Box::new(|_, _, _| None),
        resolve_string: Box::new(|_, _| None),
    };
    options.fontdb = FONT_DATABASE
        .get_or_init(|| {
            let mut database = resvg::usvg::fontdb::Database::new();
            database.load_system_fonts();
            Arc::new(database)
        })
        .clone();

    let tree = resvg::usvg::Tree::from_data(bytes, &options).map_err(|error| {
        AssetPreviewError::decode_failed(format!("Failed to parse SVG preview: {error}"))
    })?;
    let source_size = tree.size();
    let longest_side = source_size.width().max(source_size.height());
    let scale = (MAX_SVG_PREVIEW_DIMENSION as f32 / longest_side).min(1.0);
    let width = (source_size.width() * scale)
        .ceil()
        .clamp(1.0, MAX_SVG_PREVIEW_DIMENSION as f32) as u32;
    let height = (source_size.height() * scale)
        .ceil()
        .clamp(1.0, MAX_SVG_PREVIEW_DIMENSION as f32) as u32;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height).ok_or_else(|| {
        AssetPreviewError::decode_failed(format!(
            "Failed to allocate SVG preview canvas: {width}x{height}"
        ))
    })?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let png = pixmap.encode_png().map_err(|error| {
        AssetPreviewError::encode_failed(format!("Failed to encode SVG preview as PNG: {error}"))
    })?;
    Ok(("image/png", png))
}

/// 图片解码限制同时约束维度和分配；原文件读取上限并不能阻止压缩纹理解出巨幅像素。
fn image_preview_limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(256 * 1024 * 1024);
    limits
}

/// 对绕过 `image::Limits` 的自定义解码路径执行同等的单缓冲分配预算。
fn ensure_decoded_image_allocation(
    width: u32,
    height: u32,
    bytes_per_pixel: usize,
    file_name: &str,
) -> Result<usize, AssetPreviewError> {
    const MAX_IMAGE_DIMENSION: u32 = 16_384;
    const MAX_DECODED_BUFFER_BYTES: usize = 256 * 1024 * 1024;

    let pixel_count = (width as usize)
        .checked_mul(height as usize)
        .ok_or_else(|| {
            AssetPreviewError::decode_failed(format!(
                "Decoded image dimensions overflow for {file_name}: {width}x{height}"
            ))
        })?;
    let allocation = pixel_count.checked_mul(bytes_per_pixel).ok_or_else(|| {
        AssetPreviewError::decode_failed(format!(
            "Decoded image allocation overflows for {file_name}: {width}x{height}"
        ))
    })?;
    if width > MAX_IMAGE_DIMENSION
        || height > MAX_IMAGE_DIMENSION
        || allocation > MAX_DECODED_BUFFER_BYTES
    {
        return Err(AssetPreviewError::decode_failed(format!(
            "Decoded image {file_name} exceeds the preview memory budget: {width}x{height}, {allocation} bytes"
        )));
    }
    Ok(pixel_count)
}

/// 兼容部分工具导出的 24 位色表 TGA 描述符。
///
/// TGA 描述符低 4 位表示每个最终颜色的属性位数量，24 位 BGR 色表没有 Alpha，
/// 因而这里应为 0。部分 Godot 资产会写成 8；`image` 会据此推导出不存在的
/// “8 位属性 + 16 位颜色”布局，并以 `Unknown(8)` 拒绝解码。
///
/// 这里只修正已明确冲突的“色表图 + 24 位色表”组合，并保留描述符中的屏幕原点
/// 与交错标记等高 4 位。32 位色表的 8 位 Alpha、真彩图和灰度图均不受影响。
fn normalize_tga_preview_header(bytes: &mut [u8]) {
    const TGA_HEADER_LENGTH: usize = 18;
    const COLOR_MAP_PRESENT: u8 = 1;
    const RAW_COLOR_MAP_IMAGE: u8 = 1;
    const RLE_COLOR_MAP_IMAGE: u8 = 9;
    const COLOR_MAP_ENTRY_SIZE_OFFSET: usize = 7;
    const IMAGE_DESCRIPTOR_OFFSET: usize = 17;
    const ATTRIBUTE_BITS_MASK: u8 = 0x0f;

    if bytes.len() < TGA_HEADER_LENGTH
        || bytes[1] != COLOR_MAP_PRESENT
        || !matches!(bytes[2], RAW_COLOR_MAP_IMAGE | RLE_COLOR_MAP_IMAGE)
        || bytes[COLOR_MAP_ENTRY_SIZE_OFFSET] != 24
    {
        return;
    }

    bytes[IMAGE_DESCRIPTOR_OFFSET] &= !ATTRIBUTE_BITS_MASK;
}

/// 将解码后的 `DynamicImage` 重编码为 PNG 载荷。
fn encode_texture_preview_png(
    image: image::DynamicImage,
) -> Result<(&'static str, Vec<u8>), AssetPreviewError> {
    let mut png_bytes = Vec::new();
    image
        .write_to(
            &mut std::io::Cursor::new(&mut png_bytes),
            image::ImageFormat::Png,
        )
        .map_err(|error| {
            AssetPreviewError::encode_failed(format!(
                "Failed to encode the texture preview as PNG: {error}"
            ))
        })?;
    Ok(("image/png", png_bytes))
}

/// 当 image crate 的 EXR 解码器拒绝单通道 Y 图像时，使用 exr crate 直接读取。
/// Y 通道被复制到 R/G/B，Alpha 固定为 1.0，随后走同一条色调映射管线。
fn decode_exr_single_channel(
    bytes: &[u8],
    file_name: &str,
) -> Result<image::DynamicImage, AssetPreviewError> {
    use exr::image::read::image::ReadLayers as _;
    use exr::image::read::layers::ReadChannels as _;

    // 使用 exr 的 builder API 读取第一个非 Deep 图层的所有通道。
    let exr_image = exr::image::read::read()
        .no_deep_data()
        .largest_resolution_level()
        .all_channels()
        .first_valid_layer()
        .all_attributes()
        // 单文件预览受全局重读门串行保护；并行解压不会提高交互吞吐，反而会让
        // 短命像素块落入多个 Rayon 工作线程的原生分配器缓存。Windows 不会主动
        // 归还这些线程堆的提交页，连续切换 EXR 时便表现为只涨不降的 Private Bytes。
        .non_parallel()
        .from_buffered(std::io::BufReader::new(Cursor::new(bytes)))
        .map_err(|error| {
            AssetPreviewError::decode_failed(format!(
                "Failed to read EXR layer for {file_name}: {error}"
            ))
        })?;

    let layer = exr_image.layer_data;
    let resolution = layer.size;
    let width = resolution.0 as u32;
    let height = resolution.1 as u32;

    if width == 0 || height == 0 {
        return Err(AssetPreviewError::decode_failed(format!(
            "EXR image {file_name} has zero dimensions"
        )));
    }

    // 在通道列表中寻找 Y 或第一个可用通道。
    // AnyChannels.list 按字母排序；优先匹配 "Y"，否则取第一个。
    let channel_list = &layer.channel_data.list;
    let target_idx = channel_list
        .iter()
        .position(|ch| ch.name.to_string() == "Y")
        .or_else(|| {
            if channel_list.is_empty() {
                None
            } else {
                Some(0)
            }
        })
        .ok_or_else(|| {
            AssetPreviewError::decode_failed(format!("EXR image {file_name} has no channel data"))
        })?;

    // exr crate 的 FlatSamples 直接存储原始像素值。
    // 读取像素并转换为 Rgba32f → 色调映射在调用方完成。
    let pixel_count = ensure_decoded_image_allocation(width, height, 16, file_name)?;
    let mut rgba = Vec::with_capacity(pixel_count * 4);

    match &channel_list[target_idx].sample_data {
        exr::image::FlatSamples::F32(values) => {
            for &v in values.iter().take(pixel_count) {
                rgba.push(v);
                rgba.push(v);
                rgba.push(v);
                rgba.push(1.0);
            }
        }
        exr::image::FlatSamples::F16(values) => {
            for &v in values.iter().take(pixel_count) {
                let f = f32::from(v);
                rgba.push(f);
                rgba.push(f);
                rgba.push(f);
                rgba.push(1.0);
            }
        }
        exr::image::FlatSamples::U32(values) => {
            for &v in values.iter().take(pixel_count) {
                let f = v as f32;
                rgba.push(f);
                rgba.push(f);
                rgba.push(f);
                rgba.push(1.0);
            }
        }
    }

    let rgba_image = image::Rgba32FImage::from_raw(width, height, rgba).ok_or_else(|| {
        AssetPreviewError::decode_failed(format!(
            "Failed to construct RGBA image from EXR {file_name}"
        ))
    })?;
    Ok(image::DynamicImage::ImageRgba32F(rgba_image))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    /// 记录随机读取器实际消费的字节数，确保测试不会只验证“结果正确”而漏掉整文件读取回归。
    struct CountingReader {
        inner: Cursor<Vec<u8>>,
        bytes_read: usize,
    }

    impl CountingReader {
        fn new(bytes: Vec<u8>) -> Self {
            Self {
                inner: Cursor::new(bytes),
                bytes_read: 0,
            }
        }
    }

    impl std::io::Read for CountingReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let read = self.inner.read(buffer)?;
            self.bytes_read += read;
            Ok(read)
        }
    }

    impl std::io::Seek for CountingReader {
        fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
            self.inner.seek(position)
        }
    }

    /// 生成 2×2 Blender 编辑器缩略图：文件中底行是红色、顶行是蓝色。
    fn blender_thumbnail_body() -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&2u32.to_le_bytes());
        body.extend_from_slice(&2u32.to_le_bytes());
        body.extend_from_slice(&[255, 0, 0, 255, 255, 0, 0, 255]);
        body.extend_from_slice(&[0, 0, 255, 255, 0, 0, 255, 255]);
        body
    }

    fn append_classic_blender_block(output: &mut Vec<u8>, code: &[u8; 4], body: &[u8], count: u32) {
        output.extend_from_slice(code);
        output.extend_from_slice(&(body.len() as u32).to_le_bytes());
        output.extend_from_slice(&0u64.to_le_bytes());
        output.extend_from_slice(&0u32.to_le_bytes());
        output.extend_from_slice(&count.to_le_bytes());
        output.extend_from_slice(body);
    }

    fn synthetic_blender_thumbnail() -> Vec<u8> {
        let mut bytes = b"BLENDER-v300".to_vec();
        append_classic_blender_block(&mut bytes, b"TEST", &blender_thumbnail_body(), 1);
        append_classic_blender_block(&mut bytes, b"ENDB", &[], 0);
        bytes
    }

    fn append_large_blender_block(output: &mut Vec<u8>, code: &[u8; 4], body: &[u8], count: u64) {
        output.extend_from_slice(code);
        output.extend_from_slice(&0u32.to_le_bytes());
        output.extend_from_slice(&0u64.to_le_bytes());
        output.extend_from_slice(&(body.len() as u64).to_le_bytes());
        output.extend_from_slice(&count.to_le_bytes());
        output.extend_from_slice(body);
    }

    fn synthetic_blender_v5_thumbnail() -> Vec<u8> {
        let mut bytes = b"BLENDER17-01v0502".to_vec();
        append_large_blender_block(&mut bytes, b"TEST", &blender_thumbnail_body(), 1);
        append_large_blender_block(&mut bytes, b"ENDB", &[], 0);
        bytes
    }

    fn mini_png(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbaImage::from_pixel(width, height, image::Rgba([10, 200, 30, 255]));
        let mut encoded = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut encoded, image::ImageFormat::Png)
            .expect("The synthetic thumbnail should encode");
        encoded.into_inner()
    }

    /// Unreal ANSI `FString`：长度包含结尾的 NUL。
    fn unreal_fstring(value: &str) -> Vec<u8> {
        let mut encoded = ((value.len() + 1) as i32).to_le_bytes().to_vec();
        encoded.extend_from_slice(value.as_bytes());
        encoded.push(0);
        encoded
    }

    /// 最小 UE 风格包：摘要内含 ThumbnailTableOffset，表项指向真实 PNG。
    fn synthetic_unreal_thumbnail(legacy_version: i32) -> Vec<u8> {
        let png = mini_png(4, 4);
        let thumbnail_offset = 512usize;
        let table_offset = thumbnail_offset + 12 + png.len();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x9E2A_83C1u32.to_le_bytes());
        bytes.extend_from_slice(&legacy_version.to_le_bytes());
        bytes.extend_from_slice(&864i32.to_le_bytes());
        bytes.extend_from_slice(&522i32.to_le_bytes());
        bytes.extend_from_slice(&1009i32.to_le_bytes());
        bytes.extend_from_slice(&0i32.to_le_bytes());
        if legacy_version <= -9 {
            bytes.extend_from_slice(&[0xAB; 20]);
            bytes.extend_from_slice(&(thumbnail_offset as i32).to_le_bytes());
        }
        bytes.extend_from_slice(&1i32.to_le_bytes());
        bytes.extend_from_slice(&[0u8; 20]);
        if legacy_version > -9 {
            bytes.extend_from_slice(&(thumbnail_offset as i32).to_le_bytes());
        }
        bytes.extend_from_slice(&unreal_fstring("None"));
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&8i32.to_le_bytes());
        bytes.extend_from_slice(&64i32.to_le_bytes());
        // 摘要候选窗口内填充比真实表偏移更大的垃圾整数：真实资产的名称表字节会
        // 产生大量假候选，表偏移并不总是最大的值，验证必须遍历全部候选而不是
        // 降序截断前 16 个（截断会把位于文件前部的真实表挤出验证名单）。
        for value in 1..=20u32 {
            bytes.extend_from_slice(&(1_000_000u32 + value * 10_000).to_le_bytes());
        }
        bytes.extend_from_slice(&(table_offset as i32).to_le_bytes());
        bytes.resize(thumbnail_offset, 0);
        bytes.extend_from_slice(&4i32.to_le_bytes());
        bytes.extend_from_slice(&(-4i32).to_le_bytes());
        bytes.extend_from_slice(&(png.len() as i32).to_le_bytes());
        bytes.extend_from_slice(&png);
        bytes.extend_from_slice(&1i32.to_le_bytes());
        bytes.extend_from_slice(&unreal_fstring("Texture2D"));
        bytes.extend_from_slice(&unreal_fstring("T_Test"));
        bytes.extend_from_slice(&(thumbnail_offset as i32).to_le_bytes());
        bytes
    }

    #[test]
    fn parses_ktx2_header_without_reading_level_payloads() {
        let mut bytes = b"\xABKTX 20\xBB\r\n\x1A\n".to_vec();
        for value in [37u32, 1, 1024, 512, 0, 0, 1, 9, 1] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        let preview = parse_ktx2_metadata(&bytes).unwrap();
        let StructuredAssetPreview::AssetMetadata { facts, .. } = preview else {
            panic!("expected metadata preview");
        };
        assert!(facts
            .iter()
            .any(|entry| entry.key == "width" && entry.value == "1024"));
        assert!(facts
            .iter()
            .any(|entry| entry.key == "mipLevels" && entry.value == "9"));
    }

    #[test]
    fn rejects_ktx2_headers_with_an_excessive_gpu_footprint() {
        let mut bytes = b"\xABKTX 20\xBB\r\n\x1A\n".to_vec();
        for value in [37u32, 1, 16_384, 16_384, 0, 0, 6, 1, 1] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }

        assert_eq!(
            parse_ktx2_metadata(&bytes)
                .expect_err("A multi-gigabyte decoded cubemap must be rejected from its header")
                .code,
            "binary_preview_invalid_asset"
        );
    }

    #[test]
    fn parses_quake_pak_directory_with_validated_ranges() {
        let mut bytes = vec![0u8; 80];
        bytes[..4].copy_from_slice(b"PACK");
        bytes[4..8].copy_from_slice(&16u32.to_le_bytes());
        bytes[8..12].copy_from_slice(&64u32.to_le_bytes());
        bytes[12..16].copy_from_slice(b"data");
        bytes[16..26].copy_from_slice(b"maps/a.bsp");
        bytes[72..76].copy_from_slice(&12u32.to_le_bytes());
        bytes[76..80].copy_from_slice(&4u32.to_le_bytes());
        let preview = parse_quake_pak(&bytes).unwrap();
        let StructuredAssetPreview::Archive { entries, .. } = preview else {
            panic!("expected archive preview");
        };
        assert_eq!(entries[0].path, "maps/a.bsp");
        assert_eq!(entries[0].size, 4);
    }

    #[test]
    fn rejects_lz4_output_larger_than_declared() {
        let error = lz4_decompress_block(&[0x10, b'a'], 0, 16).unwrap_err();
        assert_eq!(error.code, "binary_preview_invalid_asset");
    }

    #[test]
    fn decodes_bounded_lz4_literal_block() {
        assert_eq!(
            lz4_decompress_block(&[0x30, b'a', b'b', b'c'], 3, 16).unwrap(),
            b"abc"
        );
    }

    #[test]
    fn lists_zip_central_directory_without_extracting_entries() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("Data/config.bin", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"data").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let preview = parse_zip_directory(&bytes).unwrap();
        let StructuredAssetPreview::Archive { entries, .. } = preview else {
            panic!("expected archive preview");
        };
        assert_eq!(entries[0].path, "Data/config.bin");
        assert_eq!(entries[0].size, 4);
    }

    #[test]
    fn lists_uncompressed_unityfs_block_info_nodes() {
        let mut block_info = vec![0u8; 16];
        block_info.extend_from_slice(&0u32.to_be_bytes());
        block_info.extend_from_slice(&1u32.to_be_bytes());
        block_info.extend_from_slice(&0u64.to_be_bytes());
        block_info.extend_from_slice(&4u64.to_be_bytes());
        block_info.extend_from_slice(&0u32.to_be_bytes());
        block_info.extend_from_slice(b"CAB-test\0");

        let mut bytes = b"UnityFS\0".to_vec();
        bytes.extend_from_slice(&6u32.to_be_bytes());
        bytes.extend_from_slice(b"2022.3\0");
        bytes.extend_from_slice(b"2022.3.1f1\0");
        bytes.extend_from_slice(&0u64.to_be_bytes());
        bytes.extend_from_slice(&(block_info.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&(block_info.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&0u32.to_be_bytes());
        bytes.extend_from_slice(&block_info);

        let preview = parse_unity_bundle(&bytes).unwrap();
        let StructuredAssetPreview::Archive { entries, .. } = preview else {
            panic!("expected archive preview");
        };
        assert_eq!(entries[0].path, "CAB-test");
        assert_eq!(entries[0].size, 4);
    }

    #[test]
    fn lists_unencrypted_godot_pck_entries() {
        let mut bytes = b"GDPC".to_vec();
        for value in [2u32, 4, 3, 0, 0] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.extend_from_slice(&[0u8; 64]);
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&9u32.to_le_bytes());
        bytes.extend_from_slice(b"main.res\0");
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.extend_from_slice(&4u64.to_le_bytes());
        bytes.extend_from_slice(&[0u8; 16]);
        bytes.extend_from_slice(&0u32.to_le_bytes());
        let preview = parse_godot_pck(&bytes).unwrap();
        let StructuredAssetPreview::Archive { entries, .. } = preview else {
            panic!("expected archive preview");
        };
        assert_eq!(entries[0].path, "main.res");
    }

    #[test]
    fn parses_stable_headers_for_unreal_unity_and_godot_assets() {
        let mut unreal = Vec::new();
        unreal.extend_from_slice(&0x9E2A83C1u32.to_le_bytes());
        unreal.extend_from_slice(&(-8i32).to_le_bytes());
        unreal.extend_from_slice(&864i32.to_le_bytes());
        unreal.extend_from_slice(&[0u8; 8]);
        assert!(matches!(
            parse_unreal_asset("uasset", &unreal)
                .unwrap()
                .structured_preview,
            StructuredAssetPreview::AssetMetadata { .. }
        ));

        let mut unity = Vec::new();
        unity.extend_from_slice(&8u32.to_be_bytes());
        unity.extend_from_slice(&32u32.to_be_bytes());
        unity.extend_from_slice(&10u32.to_be_bytes());
        unity.extend_from_slice(&28u32.to_be_bytes());
        unity.extend_from_slice(&[0, 0, 0, 0]);
        unity.extend_from_slice(b"2022.3\0");
        unity.resize(32, 0);
        assert!(matches!(
            parse_unity_serialized_file(&unity).unwrap(),
            StructuredAssetPreview::AssetMetadata { .. }
        ));

        let mut godot = b"RSRC".to_vec();
        for value in [0u32, 0, 4, 3, 5, 0] {
            godot.extend_from_slice(&value.to_le_bytes());
        }
        assert!(matches!(
            parse_godot_resource(&godot).unwrap(),
            StructuredAssetPreview::AssetMetadata { .. }
        ));
    }

    #[test]
    fn unreal_thumbnail_table_decodes_ue5_package_generations() {
        for (legacy_version, path) in [(-8, "Content/T_Test.uasset"), (-9, "Content/World.umap")] {
            let prepared = prepare_file_preview_payload(
                Path::new(path),
                "asset",
                "application/x-unreal-asset",
                synthetic_unreal_thumbnail(legacy_version),
            )
            .expect("A validated Unreal thumbnail table should produce a preview");
            assert_eq!(prepared.mime_type, "image/png");
            let decoded =
                image::load_from_memory_with_format(&prepared.data, image::ImageFormat::Png)
                    .expect("The Unreal thumbnail should be re-encoded as PNG");
            assert_eq!((decoded.width(), decoded.height()), (4, 4));
            let Some(StructuredAssetPreview::AssetMetadata { warning_codes, .. }) =
                prepared.structured_preview
            else {
                panic!("expected Unreal metadata alongside the thumbnail");
            };
            assert!(!warning_codes.contains(&"unrealEmbeddedThumbnailUnavailable"));
        }
    }

    #[test]
    fn large_unreal_thumbnail_reader_uses_bounded_ranges() {
        let mut bytes = synthetic_unreal_thumbnail(-9);
        bytes.resize(24 * 1024 * 1024, 0);
        let file_size = bytes.len() as u64;
        let mut reader = CountingReader::new(bytes);

        let prepared = prepare_large_asset_preview_payload(
            Path::new("Content/LargeWorld.umap"),
            file_size,
            &mut reader,
        )
        .expect("A large Unreal package should use its validated thumbnail table");

        assert_eq!(prepared.mime_type, "image/png");
        assert!(!prepared.data.is_empty());
        assert!(reader.bytes_read < 4 * 1024 * 1024);
    }

    #[test]
    fn unreal_body_image_without_thumbnail_table_is_not_used_as_preview() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&0x9E2A_83C1u32.to_le_bytes());
        bytes.extend_from_slice(&(-8i32).to_le_bytes());
        bytes.extend_from_slice(&864i32.to_le_bytes());
        bytes.extend_from_slice(&[0u8; 8]);
        bytes.extend_from_slice(&mini_png(8, 2));

        let prepared = prepare_file_preview_payload(
            Path::new("Content/NoTable.umap"),
            "asset",
            "application/x-unreal-asset",
            bytes,
        )
        .expect("Missing thumbnail tables should degrade to metadata");
        assert_eq!(prepared.mime_type, "application/x-unreal-asset");
        assert!(prepared.data.is_empty());
        let Some(StructuredAssetPreview::AssetMetadata { warning_codes, .. }) =
            prepared.structured_preview
        else {
            panic!("expected Unreal metadata without a guessed image");
        };
        assert!(warning_codes.contains(&"unrealEmbeddedThumbnailUnavailable"));
    }

    #[test]
    fn unreal_fstring_supports_utf16_and_rejects_hostile_lengths() {
        let mut utf16 = (-3i32).to_le_bytes().to_vec();
        for unit in [0x48u16, 0xE9, 0] {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        let mut cursor = ByteCursor::new(&utf16);
        assert_eq!(read_unreal_fstring(&mut cursor, 64).unwrap(), "Hé");

        let hostile = i32::MAX.to_le_bytes();
        let mut cursor = ByteCursor::new(&hostile);
        assert_eq!(
            read_unreal_fstring(&mut cursor, 64)
                .expect_err("A hostile FString length must be rejected")
                .code,
            "binary_preview_invalid_asset"
        );
    }

    #[test]
    fn parses_blender_block_counts_with_endianness_and_pointer_size() {
        let mut bytes = b"BLENDER-v300".to_vec();
        bytes.extend_from_slice(b"OB\0\0");
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.extend_from_slice(b"ENDB");
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u64.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        let preview = parse_blender(&bytes).unwrap();
        let StructuredAssetPreview::AssetMetadata { facts, .. } = preview.structured_preview else {
            panic!("expected metadata preview");
        };
        assert!(facts
            .iter()
            .any(|entry| entry.key == "objectCount" && entry.value == "2"));
    }

    #[test]
    fn blender_test_block_is_flipped_and_encoded_as_png() {
        let prepared = prepare_file_preview_payload(
            Path::new("Art/Hero.blend"),
            "asset",
            "application/x-blender",
            synthetic_blender_thumbnail(),
        )
        .expect("A Blender TEST block should produce a preview");
        assert_eq!(prepared.mime_type, "image/png");
        let decoded = image::load_from_memory_with_format(&prepared.data, image::ImageFormat::Png)
            .expect("The Blender thumbnail should be a valid PNG")
            .to_rgba8();
        assert_eq!(decoded.dimensions(), (2, 2));
        assert_eq!(decoded.get_pixel(0, 0).0, [0, 0, 255, 255]);
        assert_eq!(decoded.get_pixel(0, 1).0, [255, 0, 0, 255]);
        assert!(prepared.structured_preview.is_some());
    }

    #[test]
    fn large_blender_thumbnail_reader_skips_unrelated_file_bytes() {
        let mut bytes = synthetic_blender_thumbnail();
        bytes.resize(24 * 1024 * 1024, 0);
        let file_size = bytes.len() as u64;
        let mut reader = CountingReader::new(bytes);

        let prepared = prepare_large_asset_preview_payload(
            Path::new("Art/LargeHero.blend"),
            file_size,
            &mut reader,
        )
        .expect("A large Blender file should seek directly to its TEST block");

        assert_eq!(prepared.mime_type, "image/png");
        assert!(!prepared.data.is_empty());
        assert!(reader.bytes_read < 1024);
    }

    #[test]
    fn blender_v5_large_test_block_is_decoded() {
        let parsed = parse_blender(&synthetic_blender_v5_thumbnail())
            .expect("A Blender 5 TEST block should parse");
        assert_eq!(parsed.thumbnail.unwrap().dimensions(), (2, 2));
    }

    #[test]
    fn blender_zstd_and_gzip_thumbnails_use_bounded_decompression() {
        let source = synthetic_blender_thumbnail();
        let zstd = zstd::encode_all(source.as_slice(), 3).expect("zstd compress");
        let mut gzip_encoder =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gzip_encoder.write_all(&source).expect("gzip write");
        let gzip = gzip_encoder.finish().expect("gzip finish");

        for (name, compressed) in [("zstd", zstd), ("gzip", gzip)] {
            let parsed = parse_blender(&compressed)
                .unwrap_or_else(|error| panic!("{name} Blender should parse: {error:?}"));
            assert_eq!(parsed.thumbnail.unwrap().dimensions(), (2, 2), "{name}");
        }
    }

    #[test]
    fn parses_blender_17_byte_header_with_large_bhead8() {
        // 新 17 字节头部：BLENDER17-01v0502（Blender 5.02，64-bit LE）
        let mut bytes = b"BLENDER17-01v0502".to_vec();
        // OB 块 — LargeBHead8: code(4) + SDNAnr(4) + ptr(8) + len(8) + nr(8)
        bytes.extend_from_slice(b"OB\0\0");
        bytes.extend_from_slice(&0u32.to_le_bytes()); // SDNAnr
        bytes.extend_from_slice(&0u64.to_le_bytes()); // old pointer
        bytes.extend_from_slice(&0i64.to_le_bytes()); // len
        bytes.extend_from_slice(&3i64.to_le_bytes()); // nr = 3
                                                      // ENDB 块
        bytes.extend_from_slice(b"ENDB");
        bytes.extend_from_slice(&0u32.to_le_bytes()); // SDNAnr
        bytes.extend_from_slice(&0u64.to_le_bytes()); // old pointer
        bytes.extend_from_slice(&0i64.to_le_bytes()); // len
        bytes.extend_from_slice(&0i64.to_le_bytes()); // nr
        let preview = parse_blender(&bytes).unwrap();
        let StructuredAssetPreview::AssetMetadata { facts, .. } = preview.structured_preview else {
            panic!("expected metadata preview");
        };
        assert!(facts
            .iter()
            .any(|entry| entry.key == "version" && entry.value == "0502"));
        assert!(facts
            .iter()
            .any(|entry| entry.key == "objectCount" && entry.value == "3"));
        assert!(facts
            .iter()
            .any(|entry| entry.key == "headerVersion" && entry.value == "1"));
        assert!(facts
            .iter()
            .any(|entry| entry.key == "pointerSize" && entry.value == "64"));
    }

    #[test]
    fn binary_preview_allows_only_common_images_pdfs_and_game_assets() {
        assert_eq!(
            binary_preview_format(Path::new("Content/Textures/Sky.PNG")),
            Some(("image", "image/png"))
        );
        assert_eq!(
            binary_preview_format(Path::new("Docs/Design.pdf")),
            Some(("pdf", "application/pdf"))
        );
        assert_eq!(
            binary_preview_format(Path::new("Content/Textures/Albedo.TGA")),
            Some(("image", "image/x-tga"))
        );
        assert_eq!(
            binary_preview_format(Path::new("Content/Meshes/Hero.FBX")),
            Some(("model", "model/fbx"))
        );
        assert_eq!(
            binary_preview_format(Path::new("Content/Meshes/Prop.gltf")),
            Some(("model", "model/gltf+json"))
        );
        assert_eq!(
            binary_preview_format(Path::new("Data/Stats.CSV")),
            Some(("csv", "text/csv"))
        );
        assert_eq!(
            binary_preview_format(Path::new("Images/vector.svg")),
            Some(("image", "image/svg+xml"))
        );
        assert_eq!(
            binary_preview_format(Path::new("Content/Textures/Sky.DDS")),
            Some(("image", "image/vnd-ms.dds"))
        );
        assert_eq!(
            binary_preview_format(Path::new("Content/Textures/Sky.ktx2")),
            Some(("texture", "image/ktx2"))
        );
        assert_eq!(
            binary_preview_format(Path::new("Audio/Theme.flac")),
            Some(("audio", "audio/flac"))
        );
        assert_eq!(
            binary_preview_format(Path::new("Build/Game.pak")),
            Some(("archive", "application/x-pak"))
        );
        assert_eq!(
            binary_preview_format(Path::new("Build/Game.assetbundle")),
            Some(("archive", "application/x-unity-assetbundle"))
        );
        assert_eq!(
            binary_preview_format(Path::new("Fonts/Interface.ttf")),
            Some(("font", "font/ttf"))
        );
        assert_eq!(
            binary_preview_format(Path::new("Content/Map.umap")),
            Some(("asset", "application/x-unreal-asset"))
        );
        assert_eq!(
            binary_preview_format(Path::new("Content/Map.unknown")),
            None
        );
    }

    #[test]
    fn tga_texture_preview_is_converted_to_png_payload() {
        // 1×1 未压缩 TGA：18 字节头 + BGRA 像素，足以验证解码与 PNG 重编码。
        let mut tga = vec![0u8; 18];
        tga[2] = 2; // 未压缩真彩色
        tga[12] = 1; // 宽度
        tga[13] = 0;
        tga[14] = 1; // 高度
        tga[15] = 0;
        tga[16] = 32; // 每像素位数
        tga[17] = 8; // alpha 深度
        tga.extend_from_slice(&[0x20, 0x40, 0x80, 0xff]);

        let (mime_type, png_bytes) =
            prepare_preview_payload(Path::new("Albedo.tga"), "image", "image/x-tga", tga)
                .expect("A valid TGA should be converted to PNG");
        assert_eq!(mime_type, "image/png");
        assert!(png_bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]));
    }

    #[test]
    fn svg_preview_is_safely_rasterized_to_a_bounded_png() {
        let svg = br##"<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="50000">
          <script>alert('never executed')</script>
          <image href="file:///definitely-not-readable/secret.png" width="10" height="10"/>
          <rect width="100000" height="50000" fill="#78a4ff"/>
        </svg>"##;

        let (mime_type, png_bytes) = prepare_preview_payload(
            Path::new("diagram.svg"),
            "image",
            "image/svg+xml",
            svg.to_vec(),
        )
        .expect("A valid SVG should be rasterized without resolving external resources");
        let raster = image::load_from_memory_with_format(&png_bytes, image::ImageFormat::Png)
            .expect("The SVG preview payload should be a valid PNG");

        assert_eq!(mime_type, "image/png");
        assert_eq!(raster.width(), MAX_SVG_PREVIEW_DIMENSION);
        assert_eq!(raster.height(), MAX_SVG_PREVIEW_DIMENSION / 2);
        assert!(!png_bytes.windows(6).any(|window| window == b"script"));
    }

    #[test]
    fn color_mapped_tga_texture_preview_is_converted_to_png_payload() {
        // 该 1×1 样本保留 Godot 资产中使用的 8 位索引 + 24 位色表结构。
        // `image` 的通用 TGA 入口会把索引像素报告为 `Unknown(8)`，因此测试必须
        // 覆盖真实色表展开路径，而不能继续只验证 32 位真彩 TGA。
        let mut tga = vec![0u8; 18];
        tga[1] = 1; // 存在色表
        tga[2] = 1; // 未压缩色表索引图像
        tga[5] = 1; // 色表长度为 1
        tga[7] = 24; // 每个色表项为 BGR 24 位
        tga[12] = 1; // 宽度
        tga[14] = 1; // 高度
        tga[16] = 8; // 每个像素是 8 位色表索引
        tga[17] = 8; // 与问题资产一致，保留冲突的 8 个属性位
        tga.extend_from_slice(&[0x20, 0x40, 0x80]); // 一个 BGR 色表项
        tga.push(0); // 像素引用色表索引 0

        let (mime_type, png_bytes) =
            prepare_preview_payload(Path::new("Clouds.tga"), "image", "image/x-tga", tga)
                .expect("A valid color-mapped TGA should be converted to PNG");
        assert_eq!(mime_type, "image/png");
        assert!(png_bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]));
        let decoded = image::load_from_memory_with_format(&png_bytes, image::ImageFormat::Png)
            .expect("The converted preview should remain a valid PNG")
            .to_rgba8();
        assert_eq!(decoded.get_pixel(0, 0).0, [0x80, 0x40, 0x20, 0xff]);
    }

    #[test]
    fn dds_texture_preview_is_decoded_with_dimension_limits() {
        // 4×4 DXT1 DDS：固定头部后只有一个 8 字节压缩块，可验证专用 DdsDecoder 路径。
        let mut dds = b"DDS ".to_vec();
        for value in [124u32, 0x0008_1007, 4, 4, 8, 0, 1] {
            dds.extend_from_slice(&value.to_le_bytes());
        }
        dds.extend_from_slice(&[0u8; 44]);
        dds.extend_from_slice(&32u32.to_le_bytes());
        dds.extend_from_slice(&4u32.to_le_bytes());
        dds.extend_from_slice(b"DXT1");
        dds.extend_from_slice(&[0u8; 20]);
        dds.extend_from_slice(&0x1000u32.to_le_bytes());
        dds.extend_from_slice(&[0u8; 16]);
        dds.extend_from_slice(&[0x00, 0xf8, 0x00, 0x00, 0, 0, 0, 0]);

        let (mime_type, png_bytes) =
            prepare_preview_payload(Path::new("Albedo.dds"), "image", "image/vnd-ms.dds", dds)
                .expect("A valid DDS should be converted to PNG");
        assert_eq!(mime_type, "image/png");
        assert!(png_bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]));
    }

    #[test]
    fn exr_texture_preview_is_tone_mapped_to_png() {
        let source = image::Rgba32FImage::from_pixel(1, 1, image::Rgba([4.0, 1.0, 0.25, 1.0]));
        let source = image::DynamicImage::ImageRgba32F(source);
        let mut encoded = Cursor::new(Vec::new());
        source
            .write_to(&mut encoded, image::ImageFormat::OpenExr)
            .expect("The test EXR should encode");

        let (mime_type, png_bytes) = prepare_preview_payload(
            Path::new("Lighting.exr"),
            "image",
            "image/x-exr",
            encoded.into_inner(),
        )
        .expect("A valid EXR should be tone-mapped to PNG");
        assert_eq!(mime_type, "image/png");
        assert!(png_bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]));
    }

    #[test]
    fn binary_preview_rejects_content_larger_than_configured_limit() {
        let limit = binary_preview_limit_bytes(20.0).unwrap();
        assert!(ensure_binary_preview_size(20 * 1024 * 1024, limit).is_ok());
        assert_eq!(
            ensure_binary_preview_size(20 * 1024 * 1024 + 1, limit)
                .expect_err("Content above the limit must fail before reading")
                .code,
            "binary_preview_too_large"
        );
    }

    #[test]
    fn binary_preview_limit_accepts_fractional_values_and_rejects_invalid_ones() {
        // 整数 MiB 语义不变。
        assert_eq!(binary_preview_limit_bytes(1.0).unwrap(), 1024 * 1024);
        assert_eq!(
            binary_preview_limit_bytes(2048.0).unwrap(),
            2048 * 1024 * 1024
        );
        // 小数 MiB 向下取整换算，保持“不超过声明上限”的安全语义。
        assert_eq!(binary_preview_limit_bytes(0.01).unwrap(), 10_485);
        assert_eq!(binary_preview_limit_bytes(0.5).unwrap(), 512 * 1024);
        // 零值、负值、非有限值与字节计数器溢出都被拒绝。
        assert_eq!(
            binary_preview_limit_bytes(0.0).unwrap_err().code,
            "binary_preview_limit_invalid"
        );
        assert_eq!(
            binary_preview_limit_bytes(-1.0).unwrap_err().code,
            "binary_preview_limit_invalid"
        );
        assert_eq!(
            binary_preview_limit_bytes(f64::NAN).unwrap_err().code,
            "binary_preview_limit_invalid"
        );
        assert_eq!(
            binary_preview_limit_bytes(f64::INFINITY).unwrap_err().code,
            "binary_preview_limit_invalid"
        );
        assert_eq!(
            binary_preview_limit_bytes(f64::MAX).unwrap_err().code,
            "binary_preview_limit_invalid"
        );
    }

    #[test]
    fn decoded_exr_allocation_rejects_pixel_buffers_above_the_memory_budget() {
        assert!(ensure_decoded_image_allocation(4096, 4096, 16, "safe.exr").is_ok());
        assert_eq!(
            ensure_decoded_image_allocation(8192, 8192, 16, "oversized.exr")
                .expect_err("A one GiB RGBA32F buffer must be rejected before allocation")
                .code,
            "binary_preview_decode_failed"
        );
    }

    #[test]
    fn blender_zstd_compressed_file_is_decompressed_before_parsing() {
        // 构造最小的 Blender 旧格式文件，用 zstd 压缩后验证解压解析。
        let mut inner = b"BLENDER-v300".to_vec();
        inner.extend_from_slice(b"ENDB");
        inner.extend_from_slice(&0u32.to_le_bytes());
        inner.extend_from_slice(&0u64.to_le_bytes());
        inner.extend_from_slice(&0u32.to_le_bytes());
        inner.extend_from_slice(&0u32.to_le_bytes());

        let compressed = zstd::encode_all(inner.as_slice(), 3).expect("zstd compress");
        assert_eq!(
            &compressed[..4],
            &[0x28, 0xB5, 0x2F, 0xFD],
            "must have zstd magic"
        );

        let preview = parse_blender(&compressed).expect("zstd blender should parse");
        let StructuredAssetPreview::AssetMetadata { facts, .. } = preview.structured_preview else {
            panic!("expected metadata preview");
        };
        assert!(facts.iter().any(|f| f.key == "version" && f.value == "300"));
    }

    #[test]
    fn invalid_pck_extension_returns_none_structured_preview() {
        // 文件扩展名为 .pck 但内容不是 Godot PCK 格式时，应返回 None 而非错误。
        let not_pck = b"this is not a PCK file";
        let result = build_parsed_asset_preview(Path::new("rand.pck"), not_pck)
            .expect("should not propagate error for mismatched content");
        assert!(
            result.is_none(),
            "non-PCK content with .pck extension should return None"
        );
    }
}
