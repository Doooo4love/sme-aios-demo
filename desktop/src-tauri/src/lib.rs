//! Theodic AIOS Tauri 2 desktop runtime entry point.

pub mod ipc;
pub mod keychain;

use ipc::{execute_emergency_stop, DaemonState};
use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

fn emergency_stop_shortcut() -> Shortcut {
    #[cfg(target_os = "macos")]
    {
        Shortcut::new(Some(Modifiers::SUPER), Code::Escape)
    }
    #[cfg(not(target_os = "macos"))]
    {
        Shortcut::new(Some(Modifiers::CONTROL), Code::Escape)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let stop_shortcut = emergency_stop_shortcut();

    tauri::Builder::default()
        .manage(DaemonState::default())
        .setup(move |app| {
            #[cfg(desktop)]
            {
                let shortcut_to_match = stop_shortcut;
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app_handle, shortcut, event| {
                            if shortcut == &shortcut_to_match
                                && event.state() == ShortcutState::Pressed
                            {
                                let state = app_handle.state::<DaemonState>();
                                let _ = execute_emergency_stop(
                                    app_handle,
                                    &state,
                                    "hotkey:CmdOrCtrl+Escape",
                                    "global_shortcut",
                                );
                            }
                        })
                        .build(),
                )?;

                app.global_shortcut().register(stop_shortcut)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::get_daemon_status,
            ipc::register_device,
            ipc::trigger_emergency_stop,
            ipc::request_action_confirmation,
            ipc::revoke_local_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Theodic AIOS desktop application");
}
