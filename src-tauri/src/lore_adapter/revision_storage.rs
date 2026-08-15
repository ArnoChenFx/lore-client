//! 不可变 Revision Storage、Tree 遍历、Raw 内容读取、预览编码与结构化 Diff 比较。
//!
//! 本模块由原 `lore_adapter.rs` 按职责机械迁移而来。共享 DTO、调度与错误语义仍由
//! 父模块统一管理，避免模块化重构改变现有 IPC 契约或 Lore 调用行为。

use std::io::{self, Read, Seek, SeekFrom};

use super::*;
/// 为低层 Store 构造远端认证上下文。
///
/// 仓库配置中的 `identity` 是创建 Revision 时使用的作者身份；远端 Store 的
/// Token 则按设备账户绑定中的 user ID 查找。两者属于不同命名空间，不能用提交
/// 作者覆盖 `global_args` 已解析的账户，否则本地未缓存的二进制内容会在回源时
/// 失去认证，并被固定 Lore 版本折叠成 `Internal`。
pub(super) fn revision_storage_globals(
    repository_path: &Path,
) -> Result<LoreGlobalArgs, LoreCommandError> {
    let repository_path_string = display_path_without_windows_verbatim_prefix(repository_path);
    global_args(&repository_path_string)
}

/// 打开指定仓库的只读内容存储，并从事件中恢复公开的 opaque handle。
pub(super) fn open_revision_storage(repository_path: &str) -> Result<LoreStore, LoreCommandError> {
    let repository_path = validate_repository_path(repository_path)?;
    let configuration = read_repository_configuration(&repository_path)?;
    let globals = revision_storage_globals(&repository_path)?;
    let (remote_config, has_remote_config) = match configuration.remote_url {
        Some(remote_url) => (
            LoreStorageRemoteConfig {
                remote_url: remote_url.into(),
            },
            1,
        ),
        None => (LoreStorageRemoteConfig::default(), 0),
    };
    let result = run_operation("storage.open", move |callback| {
        lore::runtime().block_on(lore::storage::open::open(
            globals,
            LoreStorageOpenArgs {
                repository_path: repository_path.as_path().into(),
                remote_config,
                has_remote_config,
                ..Default::default()
            },
            callback,
        ))
    })?;
    ensure_operation_success(&result, "Open revision store")?;
    let handle_id = result
        .events
        .iter()
        .find(|event| event["tagName"] == "storageOpened")
        .and_then(|event| event["data"]["handleId"].as_u64())
        .ok_or_else(|| {
            LoreCommandError::new(
                "revision_storage_handle_missing",
                "Lore did not return a usable handle after opening the store",
            )
        })?;
    Ok(LoreStore { handle_id })
}

/// 尽力关闭 Revision Tree；主读取错误优先返回，清理失败不覆盖原始诊断。
pub(super) fn close_revision_tree(handle: LoreRevisionTree) {
    let _ = run_operation("revision_tree.close", move |callback| {
        lore::runtime().block_on(lore::revision_tree::close::close(
            LoreGlobalArgs::default(),
            LoreRevisionTreeCloseArgs { id: 1, handle },
            callback,
        ))
    });
}

/// 尽力关闭低层 Storage handle，防止 Inspector 反复切换 Revision 时泄漏资源。
pub(super) fn close_revision_storage(handle: LoreStore) {
    let _ = run_operation("storage.close", move |callback| {
        lore::runtime().block_on(lore::storage::close::close(
            LoreGlobalArgs::default(),
            LoreStorageCloseArgs { handle },
            callback,
        ))
    });
}

/// 从仓库状态事件取得稳定 Repository ID，供低层 Revision Tree 定位分区。
pub(super) fn read_revision_repository_id(
    repository_path: &str,
) -> Result<String, LoreCommandError> {
    let globals = global_args(repository_path)?;
    let result = run_operation("repository.status.revision", move |callback| {
        lore::runtime().block_on(lore::repository::status(
            globals,
            LoreRepositoryStatusArgs {
                staged: 0,
                scan: 0,
                check_dirty: 0,
                reset: 0,
                sync_point: 0,
                revision_only: 1,
                count: 0,
                paths: LoreArray::default(),
            },
            callback,
        ))
    })?;
    ensure_operation_success(&result, "Read repository identity")?;
    result
        .events
        .iter()
        .find(|event| event["tagName"] == "repositoryStatusRevision")
        .and_then(|event| event["data"]["repository"].as_str())
        .map(str::to_owned)
        .ok_or_else(|| {
            LoreCommandError::new(
                "repository_id_missing",
                "Lore repository status did not return a repository ID",
            )
        })
}

/// 枚举指定 Revision 的不可变文件树。
///
/// 遍历只消费 `revisionTreeChild`，不会读取工作区目录。Link 节点作为已提交对象
/// 保留但不跨仓库递归；跨 Link 继续遍历需要重新打开目标 Revision Tree，不能把
/// 目标仓库 Node ID 错当成本仓库 Node ID。
pub(super) fn collect_revision_tree_files(
    repository_path: &str,
    revision: &str,
) -> Result<Vec<RevisionTreeFile>, LoreCommandError> {
    collect_revision_tree_files_filtered(repository_path, revision, None)
}

/// 只沿目标路径的祖先目录遍历不可变树，避免读取单个文件时枚举整个大型仓库。
pub(super) fn collect_revision_tree_files_at_paths(
    repository_path: &str,
    revision: &str,
    paths: &[String],
) -> Result<Vec<RevisionTreeFile>, LoreCommandError> {
    let requested_paths = paths.iter().cloned().collect::<BTreeSet<_>>();
    collect_revision_tree_files_filtered(repository_path, revision, Some(&requested_paths))
}

/// 判断目录是否是目标文件的祖先，或文件是否与目标路径精确相等。
pub(super) fn should_visit_revision_tree_node(
    kind: u64,
    path: &str,
    requested_paths: Option<&BTreeSet<String>>,
) -> bool {
    let Some(requested_paths) = requested_paths else {
        return true;
    };
    match kind {
        // LoreNodeType::Directory
        0 => requested_paths.iter().any(|target| {
            target
                .strip_prefix(path)
                .is_some_and(|suffix| suffix.starts_with('/'))
        }),
        // LoreNodeType::File
        1 => requested_paths.contains(path),
        _ => false,
    }
}

pub(super) fn collect_revision_tree_files_filtered(
    repository_path: &str,
    revision: &str,
    requested_paths: Option<&BTreeSet<String>>,
) -> Result<Vec<RevisionTreeFile>, LoreCommandError> {
    let repository_id = read_revision_repository_id(repository_path)?;
    let store = open_revision_storage(repository_path)?;
    let load_args = (|| {
        Ok::<_, LoreCommandError>(LoreRevisionTreeLoadArgs {
            store,
            repository: repository_id.parse().map_err(|_| {
                LoreCommandError::new(
                    "invalid_repository_id",
                    "Lore repository status returned an invalid repository ID",
                )
            })?,
            revision_hash: revision.parse().map_err(|_| {
                LoreCommandError::new(
                    "invalid_revision_hash",
                    "The revision tree requires a complete and valid revision hash",
                )
            })?,
        })
    })();
    let load_args = match load_args {
        Ok(args) => args,
        Err(error) => {
            close_revision_storage(store);
            return Err(error);
        }
    };
    let load_result = run_operation("revision_tree.load", {
        move |callback| {
            lore::runtime().block_on(lore::revision_tree::load::load(
                LoreGlobalArgs::default(),
                load_args,
                callback,
            ))
        }
    });

    let load_result = match load_result {
        Ok(result) => result,
        Err(error) => {
            close_revision_storage(store);
            return Err(error);
        }
    };
    if let Err(error) = ensure_operation_success(&load_result, "Load revision tree") {
        close_revision_storage(store);
        return Err(error);
    }
    let tree_handle = match load_result
        .events
        .iter()
        .find(|event| event["tagName"] == "revisionTreeLoaded")
        .and_then(|event| event["data"]["handleId"].as_u64())
    {
        Some(handle_id) => LoreRevisionTree { handle_id },
        None => {
            close_revision_storage(store);
            return Err(LoreCommandError::new(
                "revision_tree_handle_missing",
                "Lore did not return a usable handle after loading the revision tree",
            ));
        }
    };

    let read_result = (|| {
        let mut next_call_id = 1u64;
        let mut pending_directories = vec![(0u32, String::new())];
        let mut files = Vec::new();

        while let Some((parent_node_id, parent_path)) = pending_directories.pop() {
            let call_id = next_call_id;
            next_call_id += 1;
            let result = run_operation("revision_tree.list_children", move |callback| {
                lore::runtime().block_on(lore::revision_tree::list_children::list_children(
                    LoreGlobalArgs::default(),
                    LoreRevisionTreeListChildrenArgs {
                        id: call_id,
                        handle: tree_handle,
                        parent_node_id,
                    },
                    callback,
                ))
            })?;
            ensure_operation_success(&result, "Enumerate revision tree")?;

            let listed_repository = result
                .events
                .iter()
                .find(|event| event["tagName"] == "revisionTreeListChildrenBegin")
                .and_then(|event| event["data"]["repository"].as_str())
                .unwrap_or(&repository_id)
                .to_owned();

            for event in result
                .events
                .iter()
                .filter(|event| event["tagName"] == "revisionTreeChild")
            {
                let data = &event["data"];
                let name = data["name"].as_str().unwrap_or_default();
                if name.is_empty() {
                    continue;
                }
                let path = if parent_path.is_empty() {
                    name.to_owned()
                } else {
                    format!("{parent_path}/{name}")
                };
                let kind = data["kind"].as_u64().unwrap_or_default();
                let node_id = data["nodeId"].as_u64().unwrap_or_default() as u32;

                match kind {
                    // LoreNodeType::Directory
                    0 if should_visit_revision_tree_node(kind, &path, requested_paths) => {
                        pending_directories.push((node_id, path));
                    }
                    // LoreNodeType::File
                    1 if should_visit_revision_tree_node(kind, &path, requested_paths) => files
                        .push(RevisionTreeFile {
                            path,
                            size: data["size"].as_u64().unwrap_or_default(),
                            address: data["address"].as_str().unwrap_or_default().to_owned(),
                            repository: listed_repository.clone(),
                        }),
                    // LoreNodeType::Link 是一个已提交对象，但不是本仓库普通文件。
                    _ => {}
                }
            }
        }

        files.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(files)
    })();

    close_revision_tree(tree_handle);
    close_revision_storage(store);
    read_result
}

#[derive(Default)]
pub(super) struct StorageGetCapture {
    pub(super) contents: BTreeMap<u64, Vec<u8>>,
    pub(super) error: Option<String>,
}

/** 按 Header 的精确长度预分配单个 Store 内容缓冲，避免分块到达时反复扩容。 */
pub(super) fn prepare_storage_get_buffer(
    capture: &mut StorageGetCapture,
    id: u64,
    size_content: u64,
) -> Result<(), String> {
    let size = usize::try_from(size_content)
        .map_err(|_| format!("Storage item {id} is too large for this platform"))?;
    capture.contents.insert(id, vec![0; size]);
    Ok(())
}

/**
 * 在 Lore callback 有效期内把借用字节直接复制到最终缓冲。
 *
 * 不能先调用 `serialize_lore_event`：Serde JSON 会把每个字节扩展成一个独立
 * `Value::Number`，几百 KiB 的资产就会制造几十 MiB 临时堆并持续抬高 Windows
 * Private Bytes。这个专用路径只保留一份连续 `Vec<u8>`。
 */
pub(super) fn copy_storage_get_chunk(
    capture: &mut StorageGetCapture,
    id: u64,
    offset: u64,
    bytes: &[u8],
) -> Result<(), String> {
    let start = usize::try_from(offset)
        .map_err(|_| format!("Storage item {id} has an invalid chunk offset"))?;
    let end = start
        .checked_add(bytes.len())
        .ok_or_else(|| format!("Storage item {id} chunk range overflowed"))?;
    let target = capture
        .contents
        .get_mut(&id)
        .ok_or_else(|| format!("Storage item {id} returned data before its header"))?;
    if end > target.len() {
        return Err(format!(
            "Storage item {id} returned a chunk beyond its declared content size"
        ));
    }
    target[start..end].copy_from_slice(bytes);
    Ok(())
}

/**
 * 执行低层 Store Get，同时让二进制载荷绕过通用 JSON 事件收集器。
 *
 * Header、完成状态与错误仍保留为普通事件，因而既不改变结构化错误语义，也不丢失
 * 操作流诊断；只有体积最大的 `StorageGetData` 被直接聚合为连续字节。
 */
pub(super) fn run_storage_get_operation(
    handle: LoreStore,
    items: Vec<LoreStorageGetItem>,
) -> Result<(LoreOperationResult, BTreeMap<u64, Vec<u8>>), LoreCommandError> {
    const OPERATION: &str = "storage.get";
    let operation_id = format!(
        "lore-operation-{}",
        OPERATION_STREAM_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    emit_operation_stream(LoreOperationStreamEvent {
        operation_id: operation_id.clone(),
        operation: OPERATION,
        phase: "queued",
        event: None,
        status: None,
        duration_ms: None,
        cancellable: false,
    });
    let started_at = Instant::now();
    emit_operation_stream(LoreOperationStreamEvent {
        operation_id: operation_id.clone(),
        operation: OPERATION,
        phase: "running",
        event: None,
        status: None,
        duration_ms: None,
        cancellable: false,
    });

    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let capture = Arc::new(Mutex::new(StorageGetCapture::default()));
    let event_target = Arc::clone(&events);
    let capture_target = Arc::clone(&capture);
    let callback_operation_id = operation_id.clone();
    let callback: LoreEventCallback = Some(Box::new(move |event: &LoreEvent| {
        let payload_handled = match event {
            LoreEvent::StorageGetHeader(data) => {
                if let Ok(mut target) = capture_target.lock() {
                    if target.error.is_none() {
                        target.error =
                            prepare_storage_get_buffer(&mut target, data.id, data.size_content)
                                .err();
                    }
                }
                false
            }
            LoreEvent::StorageGetData(data) => {
                if let Ok(mut target) = capture_target.lock() {
                    if target.error.is_none() {
                        // SAFETY: Lore 明确保证该借用视图在当前 callback 调用期间有效。
                        let bytes = unsafe { data.bytes.as_slice() };
                        target.error =
                            copy_storage_get_chunk(&mut target, data.id, data.offset, bytes).err();
                    }
                }
                true
            }
            _ => false,
        };
        if payload_handled {
            return;
        }

        let serialized = serialize_lore_event(event);
        if let Some(summary) = operation_stream_summary(&serialized) {
            emit_operation_stream(LoreOperationStreamEvent {
                operation_id: callback_operation_id.clone(),
                operation: OPERATION,
                phase: "streaming",
                event: Some(summary),
                status: None,
                duration_ms: None,
                cancellable: false,
            });
        }
        if let Ok(mut target) = event_target.lock() {
            target.push(serialized);
        }
    }));

    let status = lore::runtime().block_on(lore::storage::get::get(
        LoreGlobalArgs::default(),
        LoreStorageGetArgs {
            handle,
            items: LoreArray::from_vec(items),
        },
        callback,
    ));
    let events = {
        let mut target = events.lock().map_err(|_| {
            LoreCommandError::new(
                "event_collector_poisoned",
                "The Lore event collector state is poisoned",
            )
        })?;
        std::mem::take(&mut *target)
    };
    let capture = {
        let mut target = capture.lock().map_err(|_| {
            LoreCommandError::new(
                "storage_capture_poisoned",
                "The Lore storage payload collector state is poisoned",
            )
        })?;
        std::mem::take(&mut *target)
    };
    if let Some(error) = capture.error {
        return Err(LoreCommandError::new("storage_payload_invalid", error));
    }

    let duration_ms = started_at.elapsed().as_millis();
    emit_operation_stream(LoreOperationStreamEvent {
        operation_id,
        operation: OPERATION,
        phase: if status == 0 { "succeeded" } else { "failed" },
        event: None,
        status: Some(status),
        duration_ms: Some(duration_ms),
        cancellable: false,
    });
    Ok((
        LoreOperationResult {
            operation: OPERATION,
            status,
            duration_ms,
            events,
        },
        capture.contents,
    ))
}

/// 单次区间请求的捕获状态。
///
/// 与整读的 `StorageGetCapture` 不同，这里只预分配请求区间大小的缓冲：Header 始终
/// 报告完整内容大小，但区间请求只交付触及的叶片，按内容偏移换算到区间内写入。
#[derive(Default)]
pub(super) struct RangeGetCapture {
    /// 请求区间的起始内容偏移。
    pub(super) offset: u64,
    /// 请求区间内已收到的连续字节。
    pub(super) bytes: Vec<u8>,
    /// Header 报告的完整内容大小；用于把请求区间收敛到真实内容边界。
    pub(super) size_content: u64,
    pub(super) error: Option<String>,
}

/// 执行单次 Store 区间读取，只分配请求范围大小的缓冲。
///
/// Header 与完成状态仍通过与整读相同的 operation stream 上报，保持诊断一致性；
/// 只有体积最大的 `StorageGetData` 被直接聚合为区间字节，不进入通用 JSON 收集器。
pub(super) fn run_storage_range_get_operation(
    handle: LoreStore,
    item: LoreStorageGetItem,
) -> Result<Vec<u8>, LoreCommandError> {
    const OPERATION: &str = "storage.get";
    let operation_id = format!(
        "lore-operation-{}",
        OPERATION_STREAM_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    emit_operation_stream(LoreOperationStreamEvent {
        operation_id: operation_id.clone(),
        operation: OPERATION,
        phase: "queued",
        event: None,
        status: None,
        duration_ms: None,
        cancellable: false,
    });
    let started_at = Instant::now();
    emit_operation_stream(LoreOperationStreamEvent {
        operation_id: operation_id.clone(),
        operation: OPERATION,
        phase: "running",
        event: None,
        status: None,
        duration_ms: None,
        cancellable: false,
    });

    let requested_offset = item.offset;
    let requested_length = item.length;
    let capture = Arc::new(Mutex::new(RangeGetCapture::default()));
    let capture_target = Arc::clone(&capture);
    let callback: LoreEventCallback = Some(Box::new(move |event: &LoreEvent| {
        match event {
            LoreEvent::StorageGetHeader(data) => {
                if let Ok(mut target) = capture_target.lock() {
                    if target.error.is_none() {
                        target.error = prepare_range_get_buffer(
                            &mut target,
                            requested_offset,
                            requested_length,
                            data.size_content,
                        )
                        .err();
                    }
                }
            }
            LoreEvent::StorageGetData(data) => {
                if let Ok(mut target) = capture_target.lock() {
                    if target.error.is_none() {
                        // SAFETY: Lore 明确保证该借用视图在当前 callback 调用期间有效。
                        let bytes = unsafe { data.bytes.as_slice() };
                        target.error = copy_range_get_chunk(&mut target, data.offset, bytes).err();
                    }
                }
            }
            _ => {}
        }
    }));

    let status = lore::runtime().block_on(lore::storage::get::get(
        LoreGlobalArgs::default(),
        LoreStorageGetArgs {
            handle,
            items: LoreArray::from_vec(vec![item]),
        },
        callback,
    ));
    let capture = {
        let mut target = capture.lock().map_err(|_| {
            LoreCommandError::new(
                "storage_capture_poisoned",
                "The Lore storage payload collector state is poisoned",
            )
        })?;
        std::mem::take(&mut *target)
    };
    if let Some(error) = capture.error {
        return Err(LoreCommandError::new("storage_payload_invalid", error));
    }

    let duration_ms = started_at.elapsed().as_millis();
    emit_operation_stream(LoreOperationStreamEvent {
        operation_id,
        operation: OPERATION,
        phase: if status == 0 { "succeeded" } else { "failed" },
        event: None,
        status: Some(status),
        duration_ms: Some(duration_ms),
        cancellable: false,
    });
    if status != 0 {
        return Err(LoreCommandError::new(
            "storage_get_failed",
            format!("Lore store range read failed with status {status}"),
        ));
    }

    // 起始偏移越界由 Lore 以 INVALID_ARGUMENTS 拒绝；这里只收敛“读到结尾”的请求。
    let available = capture.size_content.saturating_sub(requested_offset);
    let expected = if requested_length == 0 {
        available
    } else {
        available.min(requested_length)
    };
    if capture.bytes.len() != expected as usize {
        return Err(LoreCommandError::new(
            "storage_payload_invalid",
            format!(
                "Lore store range read returned {} bytes, expected {expected}",
                capture.bytes.len()
            ),
        ));
    }
    Ok(capture.bytes)
}

/** 按请求区间（而非完整内容）预分配区间读取缓冲。 */
pub(super) fn prepare_range_get_buffer(
    capture: &mut RangeGetCapture,
    offset: u64,
    length: u64,
    size_content: u64,
) -> Result<(), String> {
    capture.offset = offset;
    capture.size_content = size_content;
    if offset > size_content {
        return Err("Lore store range read starts past the content end".to_owned());
    }
    let available = size_content - offset;
    let requested = if length == 0 {
        available
    } else {
        available.min(length)
    };
    let size = usize::try_from(requested)
        .map_err(|_| "Lore store range read exceeds this platform's size limits")?;
    capture.bytes = vec![0; size];
    Ok(())
}

/** 把内容内偏移换算到请求区间内写入，校验越界。 */
pub(super) fn copy_range_get_chunk(
    capture: &mut RangeGetCapture,
    offset: u64,
    bytes: &[u8],
) -> Result<(), String> {
    if bytes.is_empty() {
        return Ok(());
    }
    let local = offset
        .checked_sub(capture.offset)
        .ok_or_else(|| "Lore store range chunk starts before the requested offset")?;
    let end = local
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| "Lore store range chunk offset overflowed")?;
    if end > capture.bytes.len() as u64 {
        return Err("Lore store range chunk exceeds the requested range".to_owned());
    }
    capture.bytes[local as usize..end as usize].copy_from_slice(bytes);
    Ok(())
}

/// 批量区间请求中单个 item 的捕获状态；与单 item 的 `RangeGetCapture` 语义一致。
#[derive(Default)]
pub(super) struct BatchRangeItemCapture {
    /// 请求区间的起始内容偏移。
    pub(super) offset: u64,
    /// 请求区间内已收到的连续字节。
    pub(super) bytes: Vec<u8>,
    /// Header 报告的完整内容大小；用于把请求区间收敛到真实内容边界。
    pub(super) size_content: u64,
}

/// 批量区间请求的捕获状态，按调用方 id 键控。
#[derive(Default)]
pub(super) struct BatchRangeGetCapture {
    pub(super) items: BTreeMap<u64, BatchRangeItemCapture>,
    pub(super) error: Option<String>,
}

/**
 * 一次 Store 调用批量读取多个内容区间。
 *
 * 与单 item 版本共享相同的 Header/Data 语义：Header 始终报告完整内容大小，区间
 * 请求只交付触及的叶片。每个 item 独立预分配请求区间大小的缓冲，供列表阶段批量
 * 采样分类使用，避免为整份内容复制内存。
 */
pub(super) fn run_storage_range_get_batch_operation(
    handle: LoreStore,
    items: Vec<LoreStorageGetItem>,
) -> Result<BTreeMap<u64, Vec<u8>>, LoreCommandError> {
    const OPERATION: &str = "storage.get";
    let operation_id = format!(
        "lore-operation-{}",
        OPERATION_STREAM_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    emit_operation_stream(LoreOperationStreamEvent {
        operation_id: operation_id.clone(),
        operation: OPERATION,
        phase: "queued",
        event: None,
        status: None,
        duration_ms: None,
        cancellable: false,
    });
    let started_at = Instant::now();
    emit_operation_stream(LoreOperationStreamEvent {
        operation_id: operation_id.clone(),
        operation: OPERATION,
        phase: "running",
        event: None,
        status: None,
        duration_ms: None,
        cancellable: false,
    });

    let requested = items
        .iter()
        .map(|item| (item.id, (item.offset, item.length)))
        .collect::<BTreeMap<_, _>>();
    let capture = Arc::new(Mutex::new(BatchRangeGetCapture::default()));
    let capture_target = Arc::clone(&capture);
    let callback: LoreEventCallback = Some(Box::new(move |event: &LoreEvent| {
        match event {
            LoreEvent::StorageGetHeader(data) => {
                if let Ok(mut target) = capture_target.lock() {
                    if target.error.is_none() {
                        target.error = (|| {
                            let (offset, length) = *requested.get(&data.id).ok_or_else(|| {
                                format!(
                                    "Storage item {} returned a header it did not request",
                                    data.id
                                )
                            })?;
                            let item = target.items.entry(data.id).or_default();
                            item.offset = offset;
                            prepare_batch_range_item_buffer(item, length, data.size_content)
                        })()
                        .err();
                    }
                }
            }
            LoreEvent::StorageGetData(data) => {
                if let Ok(mut target) = capture_target.lock() {
                    if target.error.is_none() {
                        // SAFETY: Lore 明确保证该借用视图在当前 callback 调用期间有效。
                        let bytes = unsafe { data.bytes.as_slice() };
                        target.error = (|| {
                            let item = target.items.get_mut(&data.id).ok_or_else(|| {
                                format!("Storage item {} returned data before its header", data.id)
                            })?;
                            copy_batch_range_item_chunk(item, data.offset, bytes)
                        })()
                        .err();
                    }
                }
            }
            _ => {}
        }
    }));

    let status = lore::runtime().block_on(lore::storage::get::get(
        LoreGlobalArgs::default(),
        LoreStorageGetArgs {
            handle,
            items: LoreArray::from_vec(items),
        },
        callback,
    ));
    let capture = {
        let mut target = capture.lock().map_err(|_| {
            LoreCommandError::new(
                "storage_capture_poisoned",
                "The Lore storage payload collector state is poisoned",
            )
        })?;
        std::mem::take(&mut *target)
    };
    if let Some(error) = capture.error {
        return Err(LoreCommandError::new("storage_payload_invalid", error));
    }

    let duration_ms = started_at.elapsed().as_millis();
    emit_operation_stream(LoreOperationStreamEvent {
        operation_id,
        operation: OPERATION,
        phase: if status == 0 { "succeeded" } else { "failed" },
        event: None,
        status: Some(status),
        duration_ms: Some(duration_ms),
        cancellable: false,
    });
    if status != 0 {
        return Err(LoreCommandError::new(
            "storage_get_failed",
            format!("Lore store batch range read failed with status {status}"),
        ));
    }

    Ok(capture
        .items
        .into_iter()
        .map(|(id, item)| (id, item.bytes))
        .collect())
}

/** 按请求区间（而非完整内容）预分配批量区间读取缓冲。 */
pub(super) fn prepare_batch_range_item_buffer(
    item: &mut BatchRangeItemCapture,
    length: u64,
    size_content: u64,
) -> Result<(), String> {
    item.size_content = size_content;
    if item.offset > size_content {
        return Err("Lore store range read starts past the content end".to_owned());
    }
    let available = size_content - item.offset;
    let requested = if length == 0 {
        available
    } else {
        available.min(length)
    };
    let size = usize::try_from(requested)
        .map_err(|_| "Lore store range read exceeds this platform's size limits")?;
    item.bytes = vec![0; size];
    Ok(())
}

/** 把内容内偏移换算到批量区间内写入，校验越界。 */
pub(super) fn copy_batch_range_item_chunk(
    item: &mut BatchRangeItemCapture,
    offset: u64,
    bytes: &[u8],
) -> Result<(), String> {
    if bytes.is_empty() {
        return Ok(());
    }
    let local = offset
        .checked_sub(item.offset)
        .ok_or_else(|| "Lore store range chunk starts before the requested offset")?;
    let end = local
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| "Lore store range chunk offset overflowed")?;
    if end > item.bytes.len() as u64 {
        return Err("Lore store range chunk exceeds the requested range".to_owned());
    }
    item.bytes[local as usize..end as usize].copy_from_slice(bytes);
    Ok(())
}

/// 从内容寻址 Store 批量读取根修订中文本文件的真实字节。
pub(super) fn read_revision_file_contents_matching(
    repository_path: &str,
    files: &[RevisionTreeFile],
    should_read: impl Fn(&RevisionTreeFile) -> bool,
) -> Result<BTreeMap<String, Vec<u8>>, LoreCommandError> {
    let requested = files
        .iter()
        .filter(|file| should_read(file))
        .enumerate()
        .map(|(index, file)| {
            let partition = file.repository.parse().map_err(|_| {
                LoreCommandError::new(
                    "invalid_repository_id",
                    format!("Revision file {} has an invalid repository ID", file.path),
                )
            })?;
            let address = file.address.parse().map_err(|_| {
                LoreCommandError::new(
                    "invalid_file_address",
                    format!("Revision file {} has an invalid content address", file.path),
                )
            })?;
            Ok((
                (index + 1) as u64,
                file.path.clone(),
                LoreStorageGetItem {
                    id: (index + 1) as u64,
                    partition,
                    address,
                    // 零值区间对表示读取完整对象，保持既有整读语义。
                    offset: 0,
                    length: 0,
                    // 直接接收 Store 叶片并写入预分配的最终 Vec。非流式模式会先在
                    // Lore 内部重组一份完整 Bytes，再由 callback 复制一次；频繁预览
                    // 二进制文件时，这套双缓冲会持续抬高原生分配器高水位。
                    streaming: 1,
                    local_cache: 0,
                },
            ))
        })
        .collect::<Result<Vec<_>, LoreCommandError>>()?;

    if requested.is_empty() {
        return Ok(BTreeMap::new());
    }

    let store = open_revision_storage(repository_path)?;
    let path_by_id = requested
        .iter()
        .map(|(id, path, _)| (*id, path.clone()))
        .collect::<BTreeMap<_, _>>();
    let items = requested
        .into_iter()
        .map(|(_, _, item)| item)
        .collect::<Vec<_>>();
    let result = run_storage_get_operation(store, items);

    let read_result = result.and_then(|(result, mut content_by_id)| {
        ensure_operation_success(&result, "Read revision file content")?;
        let mut contents = BTreeMap::new();
        for (id, path) in path_by_id {
            if let Some(bytes) = content_by_id.remove(&id) {
                contents.insert(path, bytes);
            }
        }
        Ok(contents)
    });

    close_revision_storage(store);
    read_result
}

/// 根 Revision 文本 Diff 使用的批量读取入口，继续维持既有二进制跳过策略。
pub(super) fn read_revision_file_contents(
    repository_path: &str,
    files: &[RevisionTreeFile],
) -> Result<BTreeMap<String, Vec<u8>>, LoreCommandError> {
    read_revision_file_contents_matching(
        repository_path,
        files,
        should_materialize_revision_content,
    )
}

/// 二进制预览只读取已经过白名单与大小验证的单个 Revision 文件。
pub(super) fn read_revision_file_content(
    repository_path: &str,
    file: &RevisionTreeFile,
) -> Result<Vec<u8>, LoreCommandError> {
    read_revision_file_contents_matching(repository_path, std::slice::from_ref(file), |_| true)?
        .remove(&file.path)
        .ok_or_else(|| {
            LoreCommandError::new(
                "revision_preview_content_missing",
                format!(
                    "Lore store did not return content for revision file {}",
                    file.path
                ),
            )
        })
}

/// Revision 列表批量采样的单文件预算。
///
/// 列表采样在单次 Store 调用中携带全部文件，总量受文件数约束，因此单文件预算
/// 低于工作区 64 KiB 采样；4 KiB 已足以覆盖常见 BOM、magic、UTF-16 模式与控制
/// 字符分布，分类结论与 64 KiB 采样对同一文件一致。
const REVISION_LIST_SAMPLE_BYTES: u64 = 4 * 1024;

/// 通过一次批量 Store 区间读取为 Revision 树文件采样内容前缀并分类。
///
/// 只有真实返回内容的文件得到结构化分类；单个 item 缺失或整体读取失败时，缺失
/// 文件保持 `deferred`，不阻断轻量清单（列表正确性不依赖图标级分类）。
pub(super) fn classify_revision_tree_files(
    repository_path: &str,
    files: &[&RevisionTreeFile],
) -> Result<BTreeMap<String, FileContentClassification>, LoreCommandError> {
    if files.is_empty() {
        return Ok(BTreeMap::new());
    }
    let store = open_revision_storage(repository_path)?;
    let mut requested = Vec::new();
    for (index, file) in files.iter().enumerate() {
        let file = *file;
        let Ok(partition) = file.repository.parse() else {
            log::warn!(
                "Skip revision file {} with an invalid repository ID during classification",
                file.path
            );
            continue;
        };
        let Ok(address) = file.address.parse() else {
            log::warn!(
                "Skip revision file {} with an invalid content address during classification",
                file.path
            );
            continue;
        };
        requested.push((
            (index + 1) as u64,
            file,
            LoreStorageGetItem {
                id: (index + 1) as u64,
                partition,
                address,
                offset: 0,
                length: REVISION_LIST_SAMPLE_BYTES,
                streaming: 1,
                local_cache: 0,
            },
        ));
    }
    let items = requested
        .iter()
        .map(|(_, _, item)| *item)
        .collect::<Vec<_>>();
    let result = run_storage_range_get_batch_operation(store, items);
    close_revision_storage(store);

    let contents = result?;
    let mut classifications = BTreeMap::new();
    for (id, file, _) in requested {
        let Some(bytes) = contents.get(&id) else {
            continue;
        };
        let classification =
            classify_content_sample(bytes, file.size <= REVISION_LIST_SAMPLE_BYTES);
        classifications.insert(file.path.clone(), classification);
    }
    Ok(classifications)
}

/**
 * 把轻量 JSON 元数据与原始载荷组成稳定 IPC 信封。
 *
 * 前四字节是小端元数据长度，随后依次是 UTF-8 JSON 和受控二进制载荷。信封既可供
 * 诊断入口作为单个 Raw 响应返回，也可由正式预览入口分块送入 WebView；两条路径都
 * 避免 Rust Base64、JSON 字符串与前端 `atob` 在同一时刻保留多份大对象。
 */
pub(super) fn encode_file_preview_envelope(
    preview: LoreFilePreview,
) -> Result<Vec<u8>, LoreCommandError> {
    let LoreFilePreview {
        path,
        kind,
        mime_type,
        data,
        size,
        content_state,
        structured_preview,
    } = preview;
    let metadata = serde_json::to_vec(&LoreFilePreviewMetadata {
        path,
        kind,
        mime_type,
        size,
        content_state,
        structured_preview,
    })
    .map_err(|error| {
        LoreCommandError::new(
            "binary_preview_encode_failed",
            format!("Failed to encode binary preview metadata: {error}"),
        )
    })?;
    let metadata_length = u32::try_from(metadata.len()).map_err(|_| {
        LoreCommandError::new(
            "binary_preview_encode_failed",
            "Binary preview metadata exceeded the IPC envelope limit",
        )
    })?;
    let mut envelope = Vec::with_capacity(4 + metadata.len() + data.len());
    envelope.extend_from_slice(&metadata_length.to_le_bytes());
    envelope.extend_from_slice(&metadata);
    envelope.extend_from_slice(&data);
    Ok(envelope)
}

/// 为仍依赖单响应 Raw IPC 的诊断入口保留兼容包装。
pub(super) fn encode_file_preview_response(
    preview: LoreFilePreview,
) -> Result<tauri::ipc::Response, LoreCommandError> {
    encode_file_preview_envelope(preview).map(tauri::ipc::Response::new)
}

/// 统一把工作区文件或 Revision 临时文件交给大型资产随机读取器。
fn build_large_asset_preview_from_reader(
    relative_path: &Path,
    normalized_path: String,
    size: u64,
    reader: &mut (impl std::io::Read + std::io::Seek),
) -> Result<LoreFilePreview, LoreCommandError> {
    let prepared = prepare_large_asset_preview_payload(relative_path, size, reader)
        .map_err(|error| LoreCommandError::new(error.code, error.message))?;
    Ok(LoreFilePreview {
        path: normalized_path,
        kind: "asset",
        mime_type: prepared.mime_type,
        data: prepared.data,
        size,
        content_state: LoreFilePreviewContentState::Available,
        structured_preview: prepared.structured_preview,
    })
}

/// 区间读取的最小块大小：顺序流（压缩 Blender 解压）每块才发起一次 Store 请求，
/// 随机区间（Unreal 缩略图表、TEST 块）按实际请求长度直接拉取。
const REVISION_RANGE_READ_BLOCK_BYTES: u64 = 64 * 1024;

/// 通过内容寻址 Store 的区间读取实现的 `Read + Seek` 适配器。
///
/// 每个随机读请求只拉取目标区间（至少一个最小块），远端对象也只下载触及的叶片，
/// 大型 Revision 资产因此无需物化完整对象即可提取内嵌缩略图。读取器持有打开的
/// Store handle 并在 Drop 时尽力关闭，避免逐次 open/close 放大调用开销；`size`
/// 使用树元数据作为权威边界，越过末尾的读请求直接按 EOF 处理。
pub(super) struct RevisionStoreReader {
    store: LoreStore,
    partition: String,
    address: String,
    size: u64,
    position: u64,
    /// 最近一次区间读取的完整结果与其起始偏移；命中时避免重复请求。
    cached: Option<(u64, Vec<u8>)>,
}

impl RevisionStoreReader {
    pub(super) fn new(
        repository_path: &str,
        file: &RevisionTreeFile,
    ) -> Result<Self, LoreCommandError> {
        let store = open_revision_storage(repository_path)?;
        Ok(Self {
            store,
            partition: file.repository.clone(),
            address: file.address.clone(),
            size: file.size,
            position: 0,
            cached: None,
        })
    }

    /// 通过 Store 读取 `[offset, offset+length)`，返回实际到达的字节。
    fn read_range(&mut self, offset: u64, length: u64) -> Result<Vec<u8>, LoreCommandError> {
        let partition = self.partition.parse().map_err(|_| {
            LoreCommandError::new(
                "invalid_repository_id",
                "Revision file has an invalid repository ID",
            )
        })?;
        let address = self.address.parse().map_err(|_| {
            LoreCommandError::new(
                "invalid_file_address",
                "Revision file has an invalid content address",
            )
        })?;
        run_storage_range_get_operation(
            self.store,
            LoreStorageGetItem {
                id: 1,
                partition,
                address,
                offset,
                length,
                streaming: 1,
                local_cache: 0,
            },
        )
    }
}

impl Drop for RevisionStoreReader {
    fn drop(&mut self) {
        close_revision_storage(self.store);
    }
}

impl Read for RevisionStoreReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() || self.position >= self.size {
            return Ok(0);
        }
        // 命中单块缓存时直接拷贝，顺序流读取不重复发起 Store 请求。
        if let Some((start, data)) = &self.cached {
            if self.position >= *start
                && self.position.saturating_sub(*start) + buf.len() as u64 <= data.len() as u64
            {
                let begin = (self.position - start) as usize;
                buf.copy_from_slice(&data[begin..begin + buf.len()]);
                self.position += buf.len() as u64;
                return Ok(buf.len());
            }
        }
        let request_start = self.position;
        let request_length = (buf.len() as u64)
            .max(REVISION_RANGE_READ_BLOCK_BYTES)
            .min(self.size - request_start);
        let data = self
            .read_range(request_start, request_length)
            .map_err(|error| io::Error::new(io::ErrorKind::Other, error.message))?;
        if data.is_empty() {
            // 树元数据与存储内容不一致时按 EOF 结束，避免无限重试。
            return Ok(0);
        }
        let got = data.len().min(buf.len());
        buf[..got].copy_from_slice(&data[..got]);
        self.position = request_start + got as u64;
        self.cached = Some((request_start, data));
        Ok(got)
    }
}

impl Seek for RevisionStoreReader {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let new_position = match pos {
            SeekFrom::Start(offset) => offset,
            SeekFrom::Current(delta) => (self.position as i64)
                .checked_add(delta)
                .filter(|position| *position >= 0)
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "seek underflow"))?
                as u64,
            SeekFrom::End(delta) => (self.size as i64)
                .checked_add(delta)
                .filter(|position| *position >= 0)
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "seek underflow"))?
                as u64,
        };
        // 目标仍落在缓存块内时保留缓存（例如读完 magic 后回卷到 0）；否则丢弃。
        let cache_hit = self.cached.as_ref().is_some_and(|(start, data)| {
            new_position >= *start && new_position <= *start + data.len() as u64
        });
        if !cache_hit {
            self.cached = None;
        }
        self.position = new_position;
        Ok(new_position)
    }
}

/// 用 Store 区间读取为大型 Revision 资产构建有界缩略图预览。
///
/// 只有 `supports_large_embedded_thumbnail` 白名单内的格式走这条路径；解析失败按
/// 与工作区相同的 `binary_preview_invalid_asset` 降级为元数据，不把存储错误伪装成
/// 成功。调用方必须先完成仓库相对路径与大小校验。
pub(super) fn build_revision_large_asset_preview(
    repository_path: &str,
    file: &RevisionTreeFile,
    relative_path: &Path,
    normalized_path: String,
) -> Result<LoreFilePreview, LoreCommandError> {
    let mut reader = RevisionStoreReader::new(repository_path, file)?;
    build_large_asset_preview_from_reader(relative_path, normalized_path, file.size, &mut reader)
}

/// 整读单个 Revision 文件并走完整解析；作为区间缩略图失败时的回退路径。
///
/// 完整读取后仍按预览上限二次检查，防止树元数据与真实内容不一致时绕过内存预算；
/// 回退只对不超过上限的文件执行，超限文件不因兜底而物化完整远端对象。
fn build_full_revision_preview(
    repository_path: &str,
    file: &RevisionTreeFile,
    relative_path: &Path,
    normalized_path: String,
    kind: &'static str,
    source_mime_type: &'static str,
    preview_limit_bytes: u64,
) -> Result<LoreFilePreview, LoreCommandError> {
    let bytes = read_revision_file_content(repository_path, file)?;
    ensure_binary_preview_size(bytes.len() as u64, preview_limit_bytes)?;
    // size 报告原始资产字节；纹理转码后的 PNG 只进入 Raw IPC data。
    let original_size = bytes.len() as u64;
    let prepared = prepare_file_preview_payload(relative_path, kind, source_mime_type, bytes)
        .map_err(|error| LoreCommandError::new(error.code, error.message))?;
    Ok(LoreFilePreview {
        path: normalized_path,
        kind,
        mime_type: prepared.mime_type,
        data: prepared.data,
        size: original_size,
        content_state: LoreFilePreviewContentState::Available,
        structured_preview: prepared.structured_preview,
    })
}

/// 构造单文件预览 DTO；内容在 Rust 边界内保持连续原始字节，不再生成 Base64。
pub(super) fn build_file_preview(
    repository_path: &str,
    path: &str,
    revision: Option<&str>,
    metadata_only: bool,
    preview_limit_bytes: u64,
) -> Result<LoreFilePreview, LoreCommandError> {
    let relative_path = validate_repository_relative_path(path)?;
    let normalized_path = relative_path
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    let preview_format = binary_preview_format(&relative_path);
    let (kind, source_mime_type) = preview_format.unwrap_or(("binary", "application/octet-stream"));
    /*
     * 元数据降级必须共享同一个稳定 DTO。未知格式与超限文件都不读取正文，区别只由
     * content_state 表达，前端据此显示准确原因并复用同一套大小比较布局。
     */
    let metadata_only_preview = |size, content_state| LoreFilePreview {
        path: normalized_path.clone(),
        kind,
        mime_type: source_mime_type,
        data: Vec::new(),
        size,
        content_state,
        structured_preview: None,
    };

    if let Some(revision) = revision {
        let files = collect_revision_tree_files_at_paths(
            repository_path,
            revision,
            std::slice::from_ref(&normalized_path),
        )?;
        let file = files
            .iter()
            .find(|file| file.path == normalized_path)
            .ok_or_else(|| {
                LoreCommandError::new(
                    "revision_preview_file_missing",
                    format!("File {normalized_path} does not exist in revision {revision}"),
                )
            })?;
        if metadata_only {
            return Ok(metadata_only_preview(
                file.size,
                LoreFilePreviewContentState::MetadataOnly,
            ));
        }
        if preview_format.is_none() {
            return Ok(metadata_only_preview(
                file.size,
                LoreFilePreviewContentState::Unsupported,
            ));
        }
        if supports_large_embedded_thumbnail(&relative_path) {
            /*
             * 资产格式在 Revision 侧总是优先区间缩略图读取，避免为预览物化或下载
             * 完整对象（远端冷缓存时只拉触及叶片）。区间读取失败——格式不兼容或
             * 存储错误——回退完整读取以保留 GLB 模型等完整解析能力；超限文件仍
             * 保持元数据降级，不因兜底突破完整正文内存预算。
             */
            return match build_revision_large_asset_preview(
                repository_path,
                file,
                &relative_path,
                normalized_path.clone(),
            ) {
                Ok(preview) => Ok(preview),
                Err(interval_error) => {
                    if binary_preview_size_exceeded(file.size, preview_limit_bytes) {
                        return Ok(metadata_only_preview(
                            file.size,
                            LoreFilePreviewContentState::TooLarge,
                        ));
                    }
                    match build_full_revision_preview(
                        repository_path,
                        file,
                        &relative_path,
                        normalized_path,
                        kind,
                        source_mime_type,
                        preview_limit_bytes,
                    ) {
                        Ok(preview) => Ok(preview),
                        // 完整读取也失败时保留区间路径的原始错误，便于诊断根因。
                        Err(_) => Err(interval_error),
                    }
                }
            };
        }
        if binary_preview_size_exceeded(file.size, preview_limit_bytes) {
            return Ok(metadata_only_preview(
                file.size,
                LoreFilePreviewContentState::TooLarge,
            ));
        }
        return build_full_revision_preview(
            repository_path,
            file,
            &relative_path,
            normalized_path,
            kind,
            source_mime_type,
            preview_limit_bytes,
        );
    }

    let bytes = {
        let workspace_path = validate_existing_workspace_file(repository_path, &normalized_path)?;
        let size = std::fs::metadata(&workspace_path)
            .map_err(|error| {
                LoreCommandError::new(
                    "workspace_preview_metadata_unavailable",
                    format!(
                        "Failed to read the preview file size for {}: {error}",
                        workspace_path.display()
                    ),
                )
            })?
            .len();
        if metadata_only {
            return Ok(metadata_only_preview(
                size,
                LoreFilePreviewContentState::MetadataOnly,
            ));
        }
        if preview_format.is_none() {
            return Ok(metadata_only_preview(
                size,
                LoreFilePreviewContentState::Unsupported,
            ));
        }
        if binary_preview_size_exceeded(size, preview_limit_bytes) {
            if supports_large_embedded_thumbnail(&relative_path) {
                let source = std::fs::File::open(&workspace_path).map_err(|error| {
                    LoreCommandError::new(
                        "workspace_preview_read_failed",
                        format!(
                            "Failed to open preview file {}: {error}",
                            workspace_path.display()
                        ),
                    )
                })?;
                // 读取边界以已经打开的句柄为准，避免检查路径元数据后文件并发缩放使
                // 随机读取器继续相信过期长度；这与小文件读取后的二次大小检查等价。
                let opened_size = source
                    .metadata()
                    .map_err(|error| {
                        LoreCommandError::new(
                            "workspace_preview_metadata_unavailable",
                            format!(
                                "Failed to recheck preview file size for {}: {error}",
                                workspace_path.display()
                            ),
                        )
                    })?
                    .len();
                let mut reader = std::io::BufReader::new(source);
                return match build_large_asset_preview_from_reader(
                    &relative_path,
                    normalized_path.clone(),
                    opened_size,
                    &mut reader,
                ) {
                    Ok(preview) => Ok(preview),
                    Err(error) if error.code == "binary_preview_invalid_asset" => Ok(
                        metadata_only_preview(opened_size, LoreFilePreviewContentState::TooLarge),
                    ),
                    Err(error) => Err(error),
                };
            }
            return Ok(metadata_only_preview(
                size,
                LoreFilePreviewContentState::TooLarge,
            ));
        }
        std::fs::read(&workspace_path).map_err(|error| {
            LoreCommandError::new(
                "workspace_preview_read_failed",
                format!(
                    "Failed to read preview file {}: {error}",
                    workspace_path.display()
                ),
            )
        })?
    };
    ensure_binary_preview_size(bytes.len() as u64, preview_limit_bytes)?;
    // size 报告原始资产字节；纹理转码后的 PNG 只进入 Raw IPC data。
    let original_size = bytes.len() as u64;
    let prepared = prepare_file_preview_payload(&relative_path, kind, source_mime_type, bytes)
        .map_err(|error| LoreCommandError::new(error.code, error.message))?;

    Ok(LoreFilePreview {
        path: normalized_path,
        kind,
        mime_type: prepared.mime_type,
        data: prepared.data,
        size: original_size,
        content_state: LoreFilePreviewContentState::Available,
        structured_preview: prepared.structured_preview,
    })
}

pub(super) fn should_materialize_revision_content(file: &RevisionTreeFile) -> bool {
    const ROOT_REVISION_CONTENT_PROBE_LIMIT: u64 = 8 * 1024 * 1024;
    // 固定 Lore Storage 只能返回完整对象，无法像工作区一样读取 64 KiB 前缀。根
    // Revision 的按需 Diff 因而只物化受控体积内容，再由真实 UTF-8 解码决定是否生成
    // patch；较大文件直接返回 marker，绝不凭扩展名绕过内存边界。
    file.size <= ROOT_REVISION_CONTENT_PROBE_LIMIT
}

/// 为根修订中的新增文本文件生成最小但完整的 unified patch。
pub(super) fn build_added_file_patch(path: &str, content: &[u8]) -> String {
    if content.is_empty() {
        return String::new();
    }
    let Ok(text) = std::str::from_utf8(content) else {
        return "Binary files differ\n".to_owned();
    };
    let line_count = text.lines().count().max(1);
    let mut patch = format!("--- /dev/null\n+++ {path}\n@@ -0,0 +1,{line_count} @@\n");
    for line in text.split_inclusive('\n') {
        patch.push('+');
        patch.push_str(line);
    }
    if !text.ends_with('\n') {
        patch.push('\n');
        patch.push_str("\\ No newline at end of file\n");
    }
    patch
}

/// 根 Revision 没有父 Revision，必须显式以空树作为来源。
pub(super) fn build_initial_revision_diff(
    repository_path: &str,
    target_revision: &str,
    paths: &[String],
    _context_lines: u32,
) -> Result<LoreOperationResult, LoreCommandError> {
    let started_at = Instant::now();
    let files = if paths.is_empty() {
        collect_revision_tree_files(repository_path, target_revision)?
    } else {
        collect_revision_tree_files_at_paths(repository_path, target_revision, paths)?
    };
    let contents = read_revision_file_contents(repository_path, &files)?;
    let events = files
        .iter()
        .map(|file| {
            let patch = contents
                .get(&file.path)
                .map(|content| build_added_file_patch(&file.path, content))
                .unwrap_or_else(|| "Binary files differ\n".to_owned());
            serde_json::json!({
                "tagName": "fileDiff",
                "data": {
                    "path": file.path,
                    "patch": patch,
                    "action": "add"
                }
            })
        })
        .collect();

    Ok(LoreOperationResult {
        operation: "file.diff.revision.initial",
        status: 0,
        duration_ms: started_at.elapsed().as_millis(),
        events,
    })
}

/// 用不可变树集合差补全 Lore 因“没有文本 hunk”而省略的结构变化事件。
pub(super) fn supplement_structural_diff_events(
    events: &mut Vec<Value>,
    source_files: &[RevisionTreeFile],
    target_files: &[RevisionTreeFile],
    paths: &[String],
) {
    let existing = events
        .iter()
        .filter(|event| event["tagName"] == "fileDiff")
        .flat_map(|event| {
            let mut paths = Vec::new();
            if let Some(path) = event["data"]["path"].as_str() {
                paths.push(path.to_owned());
            }
            /*
             * Move 事件的主 path 是目标路径，真实来源路径由事件的 `fromPath` 字段
             * 直接携带，不再解析补丁头文本。把两端都标记为已覆盖，避免集合差再
             * 额外伪造一个 Delete 事件。
             */
            if let Some(from_path) = event["data"]["fromPath"].as_str() {
                if !from_path.is_empty() {
                    paths.push(from_path.to_owned());
                }
            }
            paths
        })
        .collect::<BTreeSet<_>>();
    let source_paths = source_files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<BTreeSet<_>>();
    let target_paths = target_files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<BTreeSet<_>>();

    for path in source_paths.symmetric_difference(&target_paths) {
        if existing.contains(*path)
            || (!paths.is_empty() && !paths.iter().any(|item| item == *path))
        {
            continue;
        }
        let action = if target_paths.contains(path) {
            "add"
        } else {
            "delete"
        };
        events.push(serde_json::json!({
            "tagName": "fileDiff",
            "data": {
                "path": path,
                "patch": "",
                "action": action
            }
        }));
    }
}

/// 只使用不可变 Revision Tree 元数据生成稳定变化清单。
///
/// 同路径内容地址变化视为修改；来源消失且目标出现视为新增/删除。若删除项和新增项
/// 拥有相同非空内容地址，则合并为目标路径上的移动。来源中仍保留相同地址时，新路径
/// 属于复制；当前稳定前端 DTO 把复制与新增都投影为 `added`。
pub(super) fn compare_revision_tree_files(
    source_files: &[RevisionTreeFile],
    target_files: &[RevisionTreeFile],
) -> Vec<LoreRevisionChange> {
    let source_by_path = source_files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    let target_by_path = target_files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    let mut changes = Vec::new();
    let mut deleted = Vec::new();
    let mut added = Vec::new();

    for source in source_files {
        match target_by_path.get(source.path.as_str()) {
            Some(target)
                if source.address != target.address || source.repository != target.repository =>
            {
                changes.push(LoreRevisionChange {
                    path: target.path.clone(),
                    source_path: None,
                    action: "modify",
                    size: target.size,
                    content_classification: FileContentClassification::deferred(),
                });
            }
            Some(_) => {}
            None => deleted.push(source),
        }
    }
    for target in target_files {
        if !source_by_path.contains_key(target.path.as_str()) {
            added.push(target);
        }
    }

    let mut unmatched_deleted = deleted
        .iter()
        .map(|source| source.path.as_str())
        .collect::<BTreeSet<_>>();
    for target in added {
        let moved_source = deleted.iter().copied().find(|source| {
            unmatched_deleted.contains(source.path.as_str())
                && !source.address.is_empty()
                && source.address == target.address
                && source.repository == target.repository
        });
        if let Some(source) = moved_source {
            unmatched_deleted.remove(source.path.as_str());
            changes.push(LoreRevisionChange {
                path: target.path.clone(),
                source_path: Some(source.path.clone()),
                action: "move",
                size: target.size,
                content_classification: FileContentClassification::deferred(),
            });
            continue;
        }

        let copied = source_files.iter().any(|source| {
            !source.address.is_empty()
                && source.address == target.address
                && source.repository == target.repository
        });
        changes.push(LoreRevisionChange {
            path: target.path.clone(),
            source_path: None,
            action: if copied { "copy" } else { "add" },
            size: target.size,
            content_classification: FileContentClassification::deferred(),
        });
    }
    changes.extend(
        unmatched_deleted
            .into_iter()
            .filter_map(|path| source_by_path.get(path))
            .map(|source| LoreRevisionChange {
                path: source.path.clone(),
                source_path: None,
                action: "delete",
                size: source.size,
                content_classification: FileContentClassification::deferred(),
            }),
    );
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    changes
}
