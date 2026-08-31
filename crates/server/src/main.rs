//! Standalone entry point: binds an HTTP server exposing the same router
//! Tauri embeds in-process (`server::build_router`). No app-level
//! authentication — access control for a VM deployment is delegated to the
//! network layer (e.g. a Cloudflare Tunnel), per the rewrite plan's
//! locked-in decision.

#[tokio::main]
async fn main() {
    let state = server::state::AppState::default();
    let app = server::build_router(state);

    let addr = std::env::var("PRIMEROOL_ADDR").unwrap_or_else(|_| "127.0.0.1:5050".to_string());
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("failed to bind server address");
    println!("primerool-server listening on {addr}");
    axum::serve(listener, app).await.expect("server error");
}
