mod app_logging;
mod client_preferences;
mod lore_adapter;

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
            client_preferences::lore_client_preferences_load,
            client_preferences::lore_client_preferences_save,
            lore_adapter::lore_runtime_info,
            lore_adapter::lore_auth_list,
            lore_adapter::lore_auth_local_user_info,
            lore_adapter::lore_auth_user_info,
            lore_adapter::lore_auth_repository_local_user_info,
            lore_adapter::lore_auth_login_interactive,
            lore_adapter::lore_auth_login_with_token,
            lore_adapter::lore_auth_logout,
            lore_adapter::lore_auth_clear,
            lore_adapter::lore_auth_repository_binding_set,
            lore_adapter::lore_repository_probe,
            lore_adapter::lore_repository_initialize,
            lore_adapter::lore_repository_publish,
            lore_adapter::lore_repository_list,
            lore_adapter::lore_repository_info_remote,
            lore_adapter::lore_repository_clone,
            lore_adapter::lore_shared_store_info,
            lore_adapter::lore_shared_store_create,
            lore_adapter::lore_shared_store_set_use_automatically,
            lore_adapter::lore_lock_file_query,
            lore_adapter::lore_lock_file_status,
            lore_adapter::lore_lock_file_acquire,
            lore_adapter::lore_lock_file_release,
            lore_adapter::lore_file_dependency_add,
            lore_adapter::lore_file_dependency_remove,
            lore_adapter::lore_file_dependency_list,
            lore_adapter::lore_notification_subscribe,
            lore_adapter::lore_notification_unsubscribe,
            lore_adapter::lore_repository_config_get,
            lore_adapter::lore_repository_config_update,
            lore_adapter::lore_repository_view_get,
            lore_adapter::lore_repository_view_preview,
            lore_adapter::lore_repository_view_apply,
            lore_adapter::lore_repository_status,
            lore_adapter::lore_revision_history,
            lore_adapter::lore_metadata_list,
            lore_adapter::lore_revision_info,
            lore_adapter::lore_revision_find,
            lore_adapter::lore_revision_amend,
            lore_adapter::lore_revision_bisect,
            lore_adapter::lore_revision_restore,
            lore_adapter::lore_branch_list,
            lore_adapter::lore_branch_info,
            lore_adapter::lore_branch_protection_info,
            lore_adapter::lore_branch_diff,
            lore_adapter::lore_branch_latest_list,
            lore_adapter::lore_branch_set_protected,
            lore_adapter::lore_branch_reset,
            lore_adapter::lore_branch_create_from,
            lore_adapter::lore_tag_list,
            lore_adapter::lore_tag_create,
            lore_adapter::lore_tag_update,
            lore_adapter::lore_tag_delete,
            lore_adapter::lore_layer_list,
            lore_adapter::lore_layer_list_staged,
            lore_adapter::lore_layer_add,
            lore_adapter::lore_layer_remove,
            lore_adapter::lore_link_list,
            lore_adapter::lore_link_list_staged,
            lore_adapter::lore_link_add,
            lore_adapter::lore_link_remove,
            lore_adapter::lore_link_update,
            lore_adapter::lore_repository_verify,
            lore_adapter::lore_repository_verify_fragment,
            lore_adapter::lore_repository_dump,
            lore_adapter::lore_repository_instance_list,
            lore_adapter::lore_repository_instance_prune,
            lore_adapter::lore_repository_instance_update_path,
            lore_adapter::lore_repository_gc,
            lore_adapter::lore_stage,
            lore_adapter::lore_unstage,
            lore_adapter::lore_file_reset,
            lore_adapter::lore_workspace_diff,
            lore_adapter::lore_revision_changes,
            lore_adapter::lore_revision_diff,
            lore_adapter::lore_revision_files,
            lore_adapter::lore_file_preview,
            lore_adapter::lore_file_history,
            lore_adapter::lore_discard_workspace_files,
            lore_adapter::lore_open_workspace_file,
            lore_adapter::lore_detect_external_tools,
            lore_adapter::lore_open_external_diff,
            lore_adapter::lore_open_external_merge,
            lore_adapter::lore_open_patch,
            lore_adapter::lore_write_patch_file,
            lore_adapter::lore_ignore_paths,
            lore_adapter::lore_commit,
            lore_adapter::lore_sync,
            lore_adapter::lore_push,
            lore_adapter::lore_branch_switch,
            lore_adapter::lore_revision_checkout,
            lore_adapter::lore_revision_cherry_pick,
            lore_adapter::lore_revision_revert,
            lore_adapter::lore_branch_merge,
            lore_adapter::lore_conflict_session,
            lore_adapter::lore_conflict_action,
            lore_adapter::lore_branch_archive,
            lore_adapter::lore_open_workspace,
            lore_adapter::lore_reveal_workspace_file,
        ])
        .run(tauri::generate_context!())
        .expect("Failed to start Lore Client");
}
