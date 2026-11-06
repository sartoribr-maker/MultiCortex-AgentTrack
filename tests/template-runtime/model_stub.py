"""Local HTTP fixture only, no model or inference."""
import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Length','2');self.end_headers();self.wfile.write(b'OK')
 def do_POST(self):
  self.rfile.read(int(self.headers.get('Content-Length',0)))
  data=json.dumps({'choices':[{'message':{'content':'test-response-not-real-inference'}}]}).encode()
  self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.flush();time.sleep(.15);self.wfile.write(data)
 def log_message(self,*args):pass
class Server(ThreadingMixIn,HTTPServer):
 daemon_threads=True
 request_queue_size=64
parser=argparse.ArgumentParser();parser.add_argument('--port',type=int);parser.add_argument('--parallel');args=parser.parse_args()
Server(('0.0.0.0',args.port),Handler).serve_forever()
