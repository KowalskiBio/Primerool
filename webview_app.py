import webview
import multiprocessing
import threading
import time
import requests
import sys
import os

# Ensure the backend directory is in the path for imports when packaged
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend.main import app

def run_server():
    app.run(host="127.0.0.1", port=5050, debug=False, use_reloader=False)

def check_server_ready(url, timeout=30):
    start_time = time.time()
    while time.time() - start_time < timeout:
        try:
            r = requests.get(url)
            if r.status_code < 500:
                return True
        except requests.ConnectionError:
            pass
        time.sleep(0.5)
    return False

if __name__ == "__main__":
    # Required for PyInstaller multiprocessing on macOS/Windows
    multiprocessing.freeze_support()
    
    # Determine if we are running in development mode (live reload)
    is_dev = "--dev" in sys.argv
    frontend_url = "http://127.0.0.1:5173" if is_dev else "http://127.0.0.1:5050"
    backend_url = "http://127.0.0.1:5050"
    
    # Start the Flask server in a background thread
    server_thread = threading.Thread(target=run_server, daemon=True)
    server_thread.start()
    
    # Wait for the backend to initialize
    if not check_server_ready(backend_url):
        print(f"Error: Backend server did not start in time. Check logs.", file=sys.stderr)
        sys.exit(1)
        
    # Wait for the frontend to initialize if in dev mode
    if is_dev and not check_server_ready(frontend_url, timeout=60):
        print(f"Error: Vite dev server did not start in time on {frontend_url}.", file=sys.stderr)
        sys.exit(1)
    
    # Create the native window, passing the appropriate frontend URL
    webview.create_window("Primerool", frontend_url, width=1280, height=800, min_size=(800, 600))
    
    # Start the application loop (blocks until the window is closed)
    # private_mode=False ensures localStorage and cookies persist between sessions
    webview.start(private_mode=False)
