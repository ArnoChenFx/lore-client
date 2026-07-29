//! 不可信游戏资产的只读结构化预览。
//!
//! 本模块只处理已经通过仓库相对路径、符号链接和 20 MiB 原始文件限制的内存字节。
//! 所有解析器仍需自行限制目录项、路径长度、声明尺寸和递归深度，避免容器元数据触发
//! 过量分配。这里只读取目录与稳定头部；不会提取文件、执行脚本或追随外部资源。

use serde::Serialize;
use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::path::Path;

const MAX_DIRECTORY_ENTRIES: usize = 500;
const MAX_DECLARED_ENTRIES: usize = 100_000;
const MAX_PATH_BYTES: usize = 4_096;
const MAX_UNITY_BLOCK_INFO_BYTES: usize = 4 * 1024 * 1024;
const MAX_BLENDER_DECOMPRESSED_BYTES: usize = 64 * 1024 * 1024;

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

    /// 文件超过 20 MiB 内嵌预览限制。
    pub(crate) fn too_large(size: u64) -> Self {
        Self {
            code: "binary_preview_too_large",
            message: format!(
                "The file is {:.1} MB, exceeding the 20 MB embedded preview limit; \
                 open it with an external application",
                size as f64 / (1024.0 * 1024.0)
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

/// 根据扩展名选择结构化解析器。普通图片、音频、字体、PDF 和模型返回 `None`，
/// 因为它们的原始字节会交给对应的受控应用内查看器。
///
/// 当扩展名匹配但文件内容不合法（magic 不匹配等）时返回 `None` 而非错误，
/// 使前端仍可显示原始字节预览。
pub fn build_structured_preview(
    path: &Path,
    bytes: &[u8],
) -> Result<Option<StructuredAssetPreview>, AssetPreviewError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let preview = match extension.as_str() {
        "ktx2" => try_parse(parse_ktx2_metadata, bytes)?,
        "zip" => try_parse(parse_zip_directory, bytes)?,
        "pak" => try_parse(parse_pak, bytes)?,
        "assetbundle" | "bundle" | "unity3d" => try_parse(parse_unity_bundle, bytes)?,
        "pck" => try_parse(parse_godot_pck, bytes)?,
        "uasset" | "umap" | "uexp" | "ubulk" => {
            try_parse_with_ext(parse_unreal_asset, &extension, bytes)?
        }
        "assets" => try_parse(parse_unity_serialized_file, bytes)?,
        "res" => try_parse(parse_godot_resource, bytes)?,
        "blend" => try_parse(parse_blender, bytes)?,
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

/// 与 `try_parse` 相同逻辑，但解析器需要额外的扩展名参数。
fn try_parse_with_ext(
    parser: fn(&str, &[u8]) -> Result<StructuredAssetPreview, AssetPreviewError>,
    ext: &str,
    bytes: &[u8],
) -> Result<Option<StructuredAssetPreview>, AssetPreviewError> {
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
) -> Result<StructuredAssetPreview, AssetPreviewError> {
    if matches!(extension, "uexp" | "ubulk") {
        return Ok(metadata(
            format!("Unreal companion .{extension}"),
            vec![fact("fileSize", bytes.len())],
            vec!["unrealCompanionRequiresPackage"],
        ));
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
    Ok(metadata(
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
        vec!["unrealVersionedSummaryOnly"],
    ))
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

fn parse_blender(bytes: &[u8]) -> Result<StructuredAssetPreview, AssetPreviewError> {
    // Blender 5.0+ 可以使用 zstd 压缩存储。不能使用 decode_all：损坏或恶意文件
    // 可以声明超大解压结果。局部缓冲在解析结束后立即释放，不在全局状态中常驻容量。
    const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];
    if bytes.len() < 4 || bytes[..4] != ZSTD_MAGIC {
        return parse_uncompressed_blender(bytes);
    }

    let decoder = zstd::Decoder::new(Cursor::new(bytes)).map_err(|error| {
        AssetPreviewError::invalid("Blender", format!("zstd decompression failed: {error}"))
    })?;
    let mut decompressed = Vec::new();
    decoder
        .take((MAX_BLENDER_DECOMPRESSED_BYTES + 1) as u64)
        .read_to_end(&mut decompressed)
        .map_err(|error| {
            AssetPreviewError::invalid("Blender", format!("zstd decompression failed: {error}"))
        })?;
    if decompressed.len() > MAX_BLENDER_DECOMPRESSED_BYTES {
        return Ok(metadata(
            "Blender",
            vec![fact("fileSize", bytes.len()), fact("compression", "zstd")],
            vec!["blenderMetadataDecompressionLimited"],
        ));
    }
    parse_uncompressed_blender(&decompressed)
}

fn parse_uncompressed_blender(bytes: &[u8]) -> Result<StructuredAssetPreview, AssetPreviewError> {
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
        if code == b"ENDB" {
            break;
        }
        position = position
            .checked_add(data_size)
            .ok_or_else(|| AssetPreviewError::invalid("Blender", "block size overflow"))?;
        if position > bytes.len() {
            return Err(AssetPreviewError::invalid(
                "Blender",
                "block data exceeds file size",
            ));
        }
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
    Ok(metadata("Blender", facts, Vec::new()))
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

/// 判断原始资产是否超过内嵌预览上限。
///
/// 调用方可在真正读取内容前用它返回轻量大小元数据，避免为了显示“文件过大”而
/// 把整份资产载入内存。读取完成后仍须调用 `ensure_binary_preview_size` 防御并发增长。
pub fn binary_preview_size_exceeded(size: u64) -> bool {
    const MAX_BINARY_PREVIEW_BYTES: u64 = 20 * 1024 * 1024;
    size > MAX_BINARY_PREVIEW_BYTES
}

/// 同时在读取前后检查体积，避免损坏元数据或并发文件增长绕过 IPC 上限。
pub fn ensure_binary_preview_size(size: u64) -> Result<(), AssetPreviewError> {
    if binary_preview_size_exceeded(size) {
        return Err(AssetPreviewError::too_large(size));
    }
    Ok(())
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

/// 图片解码限制同时约束维度和分配；原文件 20 MiB 并不能阻止压缩纹理解出巨幅像素。
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
            parse_unreal_asset("uasset", &unreal).unwrap(),
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
        let StructuredAssetPreview::AssetMetadata { facts, .. } = preview else {
            panic!("expected metadata preview");
        };
        assert!(facts
            .iter()
            .any(|entry| entry.key == "objectCount" && entry.value == "2"));
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
        let StructuredAssetPreview::AssetMetadata { facts, .. } = preview else {
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
        assert_eq!(binary_preview_format(Path::new("Images/vector.svg")), None);
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
    fn binary_preview_rejects_content_larger_than_twenty_mb() {
        assert!(ensure_binary_preview_size(20 * 1024 * 1024).is_ok());
        assert_eq!(
            ensure_binary_preview_size(20 * 1024 * 1024 + 1)
                .expect_err("Content above the limit must fail before reading")
                .code,
            "binary_preview_too_large"
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
        let StructuredAssetPreview::AssetMetadata { facts, .. } = preview else {
            panic!("expected metadata preview");
        };
        assert!(facts.iter().any(|f| f.key == "version" && f.value == "300"));
    }

    #[test]
    fn invalid_pck_extension_returns_none_structured_preview() {
        // 文件扩展名为 .pck 但内容不是 Godot PCK 格式时，应返回 None 而非错误。
        let not_pck = b"this is not a PCK file";
        let result = build_structured_preview(Path::new("rand.pck"), not_pck)
            .expect("should not propagate error for mismatched content");
        assert!(
            result.is_none(),
            "non-PCK content with .pck extension should return None"
        );
    }
}
