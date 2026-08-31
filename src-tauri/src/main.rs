//! Tauri desktop shell: spawns `crates/server`'s axum router in-process on
//! app startup, then opens a native window pointed at it. This is the
//! direct Tauri analogue of the current app's
//! `webview.create_window("Primerool", app, width=1280, height=800,
//! min_size=(800, 600), ...)` (`backend/main.py`) — pywebview could hand a
//! WSGI app object directly to its window, but a real webview only speaks
//! HTTP, so this binds a real local TCP listener and serves the same
//! router (`server::build_router`) the standalone `primerool-server`
//! binary uses, rather than reimplementing anything shell-specific.

use std::net::TcpListener as StdTcpListener;

use tauri::{WebviewUrl, WebviewWindowBuilder};

const HOST: &str = "127.0.0.1";
/// Matches `backend/main.py`'s own fallback port (`app.run(host="127.0.0.1",
/// port=5050, ...)`, used when pywebview itself isn't available).
const DEFAULT_PORT: u16 = 5050;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Bind synchronously, before the window is created, so the
            // window's first request can never race the server starting
            // up. Falls back to an OS-assigned port (`:0`) if 5050 is
            // already taken — e.g. the standalone `primerool-server`
            // binary already running on the default port.
            let std_listener = StdTcpListener::bind((HOST, DEFAULT_PORT)).or_else(|_| StdTcpListener::bind((HOST, 0))).expect("failed to bind a local TCP port for the embedded server");
            std_listener.set_nonblocking(true).expect("failed to set listener non-blocking");
            let addr = std_listener.local_addr().expect("bound listener must have a local address");

            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(std_listener).expect("failed to adopt std listener into tokio runtime");
                let state = server::state::AppState::default();
                let router = server::build_router(state);
                axum::serve(listener, router).await.expect("embedded axum server error");
            });

            let url = format!("http://{addr}").parse().expect("constructed local server URL must be valid");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url)).title("Primerool").inner_size(1280.0, 800.0).min_inner_size(800.0, 600.0).build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Primerool Tauri application");
}
