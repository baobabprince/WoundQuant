FROM python:3.10-slim

WORKDIR /app

COPY . .

EXPOSE 10000

# Serve the current directory on the port provided by the PORT environment variable (default to 10000)
CMD ["python", "-c", "import http.server, os, socketserver; port = int(os.environ.get('PORT', 10000)); handler = http.server.SimpleHTTPRequestHandler; httpd = socketserver.TCPServer(('', port), handler); print(f'Serving on port {port}'); httpd.serve_forever()"]
