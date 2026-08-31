"""Dev entrypoint: runs the Flask API alone (no pywebview, no auto-opened browser).

Meant to run alongside `npm run dev` in frontend/, which proxies API calls
here on port 5050 while serving the Vite dev server (with hot reload) separately.
"""

from main import app

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, debug=True, use_reloader=True)
