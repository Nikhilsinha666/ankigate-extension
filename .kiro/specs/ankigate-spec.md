# AnkiGate Specification Document

## 1. Product Overview
AnkiGate is a high-discipline Manifest V3 Chrome Extension that restricts access to user-selected distracting websites until the user completes their required daily flashcard review quota in Anki. It communicates directly with Anki Desktop via local RPC (AnkiConnect), with anti-cheat checks including active window focus, card flip pacing, and optional on-device camera presence verification.

## 2. Architecture & State Machine
- **Local Anki RPC Engine**: Continuous lightweight polling to `http://127.0.0.1:8765` querying `areDuesCompleted` and card counts.
- **Anti-Cheat Pipeline**: Enforces minimum time per card to prevent fast-skipping, active desktop focus tracking, and client-side face presence checks.
- **Redirection & Interception**: Intercepts blocked domains via `declarativeNetRequest` and redirects to the local `blocked.html` lock screen.
- **Daily Latch**: Once the quota is authentically reached, sets an encrypted daily unlock latch that resets automatically at midnight.

## 3. Requirements Specification (EARS Notation)
- **REQ-1 (Distraction Interception)**: WHEN a user navigates to a blacklisted domain AND today's Anki card target is NOT complete THE SYSTEM SHALL redirect the tab to the lock challenge screen.
- **REQ-2 (AnkiConnect Querying)**: WHILE the browser session is active THE SYSTEM SHALL poll local AnkiConnect at configured intervals to query review stats.
- **REQ-3 (Anti-Cheat Validation)**: WHEN card flip intervals are under 1,000ms THE SYSTEM SHALL flag the review session as invalid to prevent mindless speed-clicking.
- **REQ-4 (Presence Verification)**: WHEN webcam presence mode is enabled THE SYSTEM SHALL throttle the study progress counter whenever the user looks away from the screen.
- **REQ-5 (Daily Latch Rollover)**: WHEN the system clock passes the configured daily reset boundary THE SYSTEM SHALL reset the unlock latch and re-lock blacklisted domains.
- **REQ-6 (Local Isolation)**: WHILE communicating with AnkiConnect THE SYSTEM SHALL restrict all network activity strictly to localhost (`127.0.0.1`) with zero external telemetry.
