"""Loopback-only Qwen embeddings for local OPOD; see the local-Qwen runbook."""

import base64
import hmac
import json
import os
import struct
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from sentence_transformers import SentenceTransformer

MODEL_ID = "Qwen/Qwen3-Embedding-0.6B"
REVISION = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"
DIMENSIONS = 1024


def main():
    api_key = os.environ["QWEN_API_KEY"]
    if len(api_key) < 16:
        raise ValueError("A local embedding token of at least 16 characters is required")
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = SentenceTransformer(
        MODEL_ID, revision=REVISION, device=device,
        trust_remote_code=False, local_files_only=True,
    )
    model.max_seq_length = 8192
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Do not log user text, credentials, or vectors.

        def respond(self, status, body):
            data = json.dumps(body, allow_nan=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path != "/health":
                self.respond(404, {"error": "not_found"})
                return
            self.respond(200, {"model": MODEL_ID, "revision": REVISION,
                               "dimensions": DIMENSIONS, "device": device})

        def do_POST(self):
            self.connection.settimeout(30)
            if self.path != "/v1/embeddings":
                self.respond(404, {"error": "not_found"})
                return
            if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + api_key):
                self.respond(401, {"error": "unauthorized"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1_048_576:
                    raise ValueError()
                body = json.loads(self.rfile.read(length))
                texts = body.get("input")
                if isinstance(texts, str):
                    texts = [texts]
                encoding = body.get("encoding_format", "float")
                if (body.get("model") != MODEL_ID
                        or body.get("dimensions", DIMENSIONS) != DIMENSIONS
                        or encoding not in ("float", "base64")
                        or not isinstance(texts, list) or not 1 <= len(texts) <= 128
                        or any(not isinstance(t, str) or not t.strip() for t in texts)):
                    raise ValueError()
                with lock:
                    tokens = model.tokenizer(texts, truncation=False)["input_ids"]
                    if any(len(t) > model.max_seq_length for t in tokens):
                        raise ValueError()
                    vectors = model.encode(texts, batch_size=4, prompt="",
                                           normalize_embeddings=True, show_progress_bar=False)
                    if vectors.shape != (len(texts), DIMENSIONS):
                        raise RuntimeError("unexpected embedding shape")
                data = []
                for index, vector in enumerate(vectors.tolist()):
                    encoded = (base64.b64encode(struct.pack("<1024f", *vector)).decode()
                               if encoding == "base64" else vector)
                    data.append({"object": "embedding", "index": index, "embedding": encoded})
                count = sum(map(len, tokens))
                self.respond(200, {"object": "list", "model": MODEL_ID, "data": data,
                                   "usage": {"prompt_tokens": count, "total_tokens": count}})
            except (ValueError, TypeError, AttributeError):
                self.respond(400, {"error": "invalid_embedding_request"})
            except Exception:
                self.respond(500, {"error": "embedding_failed"})

    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("QWEN_PORT", "8788"))), Handler)
    print(json.dumps({"ready": True, "model": MODEL_ID, "device": device}), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
