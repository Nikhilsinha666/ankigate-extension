# Architecture & Extension Guidelines for AnkiGate

## 1. Local RPC Constraints
- AnkiConnect runs locally on `127.0.0.1:8765`. Extension permissions must explicitly scope to localhost without wildcards.
- Handle connection timeouts gracefully when Anki Desktop is closed; display clear offline status without crashing background workers.

## 2. Manifest V3 Service Worker Lifecycle
- Service workers terminate after 30 seconds of inactivity. Use `chrome.alarms` for periodic Anki status checks rather than indefinite `setInterval`.
- Store user review quotas and daily unblock states in `chrome.storage.local`.

## 3. Zero-Telemetry Privacy
- Webcam presence checks run completely on-device in Web Workers or Offscreen documents.
- No video frames or Anki card data are ever transmitted to the cloud.
