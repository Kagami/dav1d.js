#!/usr/bin/env python3

import socketserver
from http.server import SimpleHTTPRequestHandler as Handler

PORT = 8000
Handler.extensions_map['.wasm'] = 'application/wasm'
Handler.extensions_map['.mjs'] = 'application/javascript'
socketserver.TCPServer.allow_reuse_address = True
httpd = socketserver.TCPServer(('127.0.0.1', PORT), Handler)
print('serving at port', PORT)
httpd.serve_forever()
