mod app_logging;
mod application_links;
mod asset_preview;
mod client_preferences;
mod lore_adapter;
mod revision_author_cache;

/// 构建并启动 Tauri 桌面应用。
pub fn run() {
    // 限制 Lore 的全局并行度，避免桌面客户端在扫描大型仓库时占满所有逻辑核心。
    let _ = lore::set_thread_limit(8);

    tauri::Builder::default()
        .plugin(app_logging::plugin())
        .setup(|app| {
            app_logging::install_panic_hook();
            lore_adapter::install_event_emitter(app.handle().clone());
            log::info!(target: "lore_client_lib::startup", "Lore Client started");
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        // Updater 负责校验签名并安装升级包；Process 只用于安装完成后的受控重启。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            app_logging::application_log_info,
            app_logging::application_log_open_directory,
            application_links::application_open_project_repository,
            application_links::application_open_project_releases,
            client_preferences::lore_client_preferences_load,
            client_preferences::lore_client_preferences_save,
            revision_author_cache::lore_revision_author_cache_get,
            revision_author_cache::lore_revision_author_cache_store,
            lore_adapter::auth::lore_runtime_info,
            lore_adapter::auth::lore_auth_list,
            lore_adapter::auth::lore_auth_local_user_info,
            lore_adapter::auth::lore_auth_user_info,
            lore_adapter::auth::lore_auth_repository_local_user_info,
            lore_adapter::auth::lore_auth_login_interactive,
            lore_adapter::auth::lore_auth_login_with_token,
            lore_adapter::auth::lore_auth_logout,
            lore_adapter::auth::lore_auth_clear,
            lore_adapter::auth::lore_auth_repository_contexts_refresh,
            lore_adapter::auth::lore_auth_repository_binding_set,
            lore_adapter::repository::lore_repository_probe,
            lore_adapter::repository::lore_repository_initialize,
            lore_adapter::repository::lore_repository_publish,
            lore_adapter::repository::lore_repository_list,
            lore_adapter::maintenance::lore_repository_info_remote,
            lore_adapter::repository::lore_repository_clone,
            lore_adapter::repository::lore_shared_store_info,
            lore_adapter::repository::lore_shared_store_create,
            lore_adapter::repository::lore_shared_store_set_use_automatically,
            lore_adapter::repository::lore_lock_file_query,
            lore_adapter::repository::lore_lock_file_status,
            lore_adapter::repository::lore_lock_file_acquire,
            lore_adapter::repository::lore_lock_file_release,
            lore_adapter::repository::lore_file_dependency_add,
            lore_adapter::repository::lore_file_dependency_remove,
            lore_adapter::repository::lore_file_dependency_list,
            lore_adapter::repository::lore_notification_subscribe,
            lore_adapter::repository::lore_notification_unsubscribe,
            lore_adapter::repository::lore_repository_config_get,
            lore_adapter::repository::lore_repository_config_update,
            lore_adapter::repository::lore_repository_view_get,
            lore_adapter::repository::lore_repository_view_preview,
            lore_adapter::repository::lore_repository_view_apply,
            lore_adapter::repository::lore_repository_status,
            lore_adapter::history::lore_revision_history,
            lore_adapter::history::lore_metadata_list,
            lore_adapter::history::lore_revision_info,
            lore_adapter::history::lore_revision_find,
            lore_adapter::history::lore_revision_amend,
            lore_adapter::history::lore_revision_bisect,
            lore_adapter::history::lore_revision_restore,
            lore_adapter::branch::lore_branch_list,
            lore_adapter::branch::lore_branch_info,
            lore_adapter::branch::lore_branch_protection_info,
            lore_adapter::branch::lore_branch_diff,
            lore_adapter::branch::lore_branch_latest_list,
            lore_adapter::branch::lore_branch_set_protected,
            lore_adapter::branch::lore_branch_reset,
            lore_adapter::branch::lore_branch_create_from,
            lore_adapter::composition::lore_tag_list,
            lore_adapter::composition::lore_tag_create,
            lore_adapter::composition::lore_tag_update,
            lore_adapter::composition::lore_tag_delete,
            lore_adapter::composition::lore_layer_list,
            lore_adapter::composition::lore_layer_list_staged,
            lore_adapter::composition::lore_layer_add,
            lore_adapter::composition::lore_layer_remove,
            lore_adapter::composition::lore_link_list,
            lore_adapter::composition::lore_link_list_staged,
            lore_adapter::composition::lore_link_add,
            lore_adapter::composition::lore_link_remove,
            lore_adapter::composition::lore_link_update,
            lore_adapter::maintenance::lore_repository_verify,
            lore_adapter::maintenance::lore_repository_verify_fragment,
            lore_adapter::maintenance::lore_repository_dump,
            lore_adapter::maintenance::lore_repository_instance_list,
            lore_adapter::maintenance::lore_repository_instance_prune,
            lore_adapter::maintenance::lore_repository_instance_update_path,
            lore_adapter::maintenance::lore_repository_gc,
            lore_adapter::workspace::lore_stage,
            lore_adapter::workspace::lore_stage_move,
            lore_adapter::workspace::lore_unstage,
            lore_adapter::workspace::lore_file_reset,
            lore_adapter::workspace::lore_workspace_diff,
            lore_adapter::workspace::lore_revision_changes,
            lore_adapter::workspace::lore_revision_diff,
            lore_adapter::workspace::lore_revision_files,
            lore_adapter::workspace::lore_file_preview,
            lore_adapter::workspace::lore_file_preview_stream,
            lore_adapter::workspace::lore_file_history,
            lore_adapter::workspace::lore_discard_workspace_files,
            lore_adapter::workspace::lore_open_workspace_file,
            lore_adapter::workspace::lore_detect_external_tools,
            lore_adapter::workspace::lore_open_external_diff,
            lore_adapter::workspace::lore_open_external_merge,
            lore_adapter::workspace::lore_open_patch,
            lore_adapter::workspace::lore_write_patch_file,
            lore_adapter::workspace::lore_ignore_paths,
            lore_adapter::operations::lore_commit,
            lore_adapter::operations::lore_sync,
            lore_adapter::operations::lore_push,
            lore_adapter::operations::lore_branch_switch,
            lore_adapter::operations::lore_revision_checkout,
            lore_adapter::operations::lore_revision_cherry_pick,
            lore_adapter::operations::lore_revision_revert,
            lore_adapter::operations::lore_branch_merge,
            lore_adapter::operations::lore_conflict_session,
            lore_adapter::operations::lore_conflict_action,
            lore_adapter::operations::lore_branch_archive,
            lore_adapter::operations::lore_open_workspace,
            lore_adapter::operations::lore_reveal_workspace_file,
        ])
        .run(tauri::generate_context!())
        .expect("Failed to start Lore Client");
}
