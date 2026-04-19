# Real-Time Quiz System — gRPC + WebSocket

Sistem kuis real-time berbasis **gRPC** (backend) dan **WebSocket** (frontend bridge) dengan browser-based UI bergaya Duolingo.

## Arsitektur

### Layer Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                       PRESENTATION LAYER                     │
│                                                              │
│   ┌──────────────────┐          ┌──────────────────────┐     │
│   │    host.html       │          │    player.html        │     │
│   │                    │          │                       │     │
│   │  • Create / Control│          │  • Join / Spectate    │     │
│   │  • Upload Soal     │          │  • Answer Buttons     │     │
│   │  • Leaderboard     │          │  • Timer + Score      │     │
│   │  • Player List     │          │  • Leaderboard        │     │
│   │  • Answer Stats    │          │  • Peer Status        │     │
│   │  • Activity Log    │          │  • Feedback Cards     │     │
│   └────────┬───────────┘          └──────────┬───────────┘     │
└────────────┼─────────────────────────────────┼─────────────────┘
             │        WebSocket (JSON)         │
             │           Port 3000             │
┌────────────┼─────────────────────────────────┼─────────────────┐
│            ▼                                 ▼                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │            BRIDGE LAYER — WebSocket Gateway               │ │
│  │                      (gateway.js)                         │ │
│  │                                                           │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │ │
│  │  │  Command      │  │   Timer      │  │  Spectator      │  │ │
│  │  │  Router       │  │   Engine     │  │  Filter         │  │ │
│  │  └──────────────┘  └──────────────┘  └────────────────┘  │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  │ │
│  │  │  Session      │  │   Answer    │  │  Leaderboard    │  │ │
│  │  │  Manager      │  │   Stats     │  │  Enricher       │  │ │
│  │  └──────────────┘  └──────────────┘  └────────────────┘  │ │
│  └──────────────────────────┬────────────────────────────────┘ │
│                             │                                 │
│                       gRPC (HTTP/2)                            │
│                         Port 50051                             │
└─────────────────────────────┼─────────────────────────────────┘
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                    SERVICE LAYER — gRPC Server                │
│                        (server.js)                            │
│                                                              │
│  ┌──────────────┐  ┌───────────────┐  ┌───────────────┐      │
│  │ QuizService  │  │ StreamService │  │ AdminService  │      │
│  │              │  │               │  │               │      │
│  │ CreateQuiz   │  │ WatchQuiz     │  │ UploadQs*     │      │
│  │ JoinQuiz     │  │  Events       │  │ StartQuiz     │      │
│  │ SubmitAnswer │  │ Watch         │  │ NextQuestion  │      │
│  │ GetResult    │  │  Leaderboard  │  │ EndQuiz       │      │
│  └──────┬───────┘  └──────┬────────┘  └──────┬────────┘      │
│         └────────────────┬┘                   │               │
│                          ▼                    │               │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │             In-Memory State (store.js)                    │ │
│  │  sessions · players · questions · scores                 │ │
│  │  EventEmitters per session (stream notifications)       │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                 CLI Clients (optional, direct gRPC)           │
│    master_client.js ─── gRPC :50051 ─── player_client.js     │
└──────────────────────────────────────────────────────────────┘

  * UploadQuestions uses client-streaming RPC
```

### Message Flow

**① Player Joins a Quiz**
```
player.html                  Gateway                      gRPC Server
    │                           │                             │
    │──── JOIN_QUIZ ──────────▶│                             │
    │                           │──── JoinQuiz() ───────────▶│
    │                           │◀──── player_id, session ────│
    │◀──── JOIN_SUCCESS ───────│                             │
    │                           │◀──── event: PLAYER_JOINED ──│
    │◀──── PLAYER_LIST_UPDATE ─│   (broadcast to all)        │
```

**② Player Submits an Answer**
```
player.html                  Gateway                      gRPC Server
    │                           │                             │
    │──── SUBMIT_ANSWER ──────▶│                             │
    │                           │──── SubmitAnswer() ───────▶│
    │                           │◀──── correct, score ───────│
    │◀──── ANSWER_RESULT ──────│                             │
    │                           │◀──── leaderboard stream ────│
    │◀──── LEADERBOARD_UPDATE ─│   (broadcast to all)        │
    │                           │──── ANSWER_STATS ──────────▶│ (host only)
    │◀──── PEER_ANSWER_STATUS ─│   (broadcast to all)        │
```

**③ Host Controls the Quiz**
```
host.html                    Gateway                      gRPC Server
    │                           │                             │
    │──── CONTROL_QUIZ ───────▶│                             │
    │                           │──── StartQuiz/Next/End() ─▶│
    │                           │◀──── question / status ─────│
    │◀──── CONTROL_RESULT ─────│                             │
    │                           │◀──── event stream ──────────│
    │◀──── QUIZ_EVENT ────────│  (QUESTION_START /          │
    │                           │   ANSWER_REVEAL / QUIZ_END) │
    │◀──── TIMER_TICK ─────────│   (gateway timer engine)    │
    │◀──── LEADERBOARD_UPDATE ─│   (from leaderboard stream) │
```

**④ Spectator Joins (Gateway-only, no gRPC call)**
```
spectator.html               Gateway
    │                           │
    │──── JOIN_AS_SPECTATOR ──▶│
    │                           │── add to session, track name
    │◀──── SPECTATOR_JOIN_OK ──│   (includes full state)
    │◀──── QUIZ_EVENT ─────────│   (read-only, no submit)
    │◀──── LEADERBOARD_UPDATE ─│   (spectators filtered out)
```

### Technology Stack

| Layer | Teknologi | Port | File |
|---|---|---|---|
| **gRPC Server** | Node.js + `@grpc/grpc-js` | 50051 | `server/`, `state/`, `proto/` |
| **WebSocket Gateway** | Express.js + `ws` + gRPC client | 3000 | `ws-gateway/gateway.js` |
| **Browser Frontend** | Vanilla HTML/CSS/JS (Duolingo-style) | 3000 (served by Express) | `web/host.html`, `web/player.html` |
| **CLI Clients** | Node.js + gRPC client | N/A | `client/master_client.js`, `client/player_client.js` |

## Struktur Direktori

```
.
├── proto/                        — gRPC service definitions
│   ├── quiz.proto                — QuizService (CreateQuiz, JoinQuiz, SubmitAnswer, GetQuizResult)
│   ├── stream.proto              — StreamService (WatchQuizEvents, WatchLeaderboard)
│   └── admin.proto               — AdminService (UploadQuestions, StartQuiz, NextQuestion, EndQuiz)
├── server/
│   ├── server.js                 — gRPC server entry point (port 50051)
│   └── services/
│       ├── quizService.js         — Unary RPCs: create, join, submit answer, get result
│       ├── streamService.js       — Server-streaming: quiz events + leaderboard
│       └── adminService.js        — Client-streaming upload + unary control RPCs
├── client/
│   ├── master_client.js           — CLI quiz host (readline-based interactive)
│   └── player_client.js           — CLI quiz player (readline-based interactive)
├── state/
│   └── store.js                   — In-memory state: sessions, players, questions, scores
├── ws-gateway/
│   └── gateway.js                 — WebSocket + Express bridge (port 3000)
├── web/
│   ├── host.html                  — Browser UI untuk quiz host/master
│   └── player.html                — Browser UI untuk player & spectator
├── package.json
├── README.md
├── SESSION_ARCHIVE.md             — Detailed changelog & feature documentation
└── WEBSOCKET_MASTERPROMPT.md      — Original WebSocket gateway specification
```

## Instalasi

```bash
npm install
```

## Menjalankan Project

### 1. Jalankan gRPC Server

```bash
npm run server
```

### 2. Jalankan WebSocket Gateway

```bash
npm run gateway
```

### 3. Buka Browser

- **Host:** http://localhost:3000/host.html
- **Player / Spectator:** http://localhost:3000/player.html

### 4. (Opsional) CLI Clients

```bash
# Host terminal
npm run master
node client/master_client.js --host "Pak Dosen"

# Player terminal
node client/player_client.js --name "Raka" --code "ABC123"
```

## Alur Penggunaan (Browser)

### Host

1. Masukkan nama host, klik **Buat Quiz**
2. Kode quiz ditampilkan — bagikan ke peserta
3. Tulis soal, isi opsi A–D, pilih jawaban benar dan waktu
4. Klik **Tambah Soal** berulang kali, lalu **Upload Semua**
5. Klik **Start** → soal pertama dikirim ke semua peserta
6. Klik **Next** untuk soal berikutnya, **End** untuk mengakhiri
7. Klik **Hasil** untuk melihat leaderboard akhir

### Player

1. Masukkan nama + kode quiz, klik **Gabung** (atau **Spectate** untuk mode spectator)
2. Tunggu soal, pilih jawaban (A/B/C/D) sebelum waktu habis
3. Feedback langsung: benar/salah/waktu habis
4. Leaderboard update real-time setiap jawaban
5. Setelah quiz berakhir, lihat hasil akhir

### Spectator

- Modus read-only: bisa melihat soal, timer, leaderboard, dan peer status
- Tidak bisa menjawab soal
- Tidak muncul di leaderboard

## Fitur Utama

### gRPC Backend (Unchanged)

| Service | RPC | Type | Description |
|---|---|---|---|
| `QuizService` | `CreateQuiz` | Unary | Host membuat session baru |
| `QuizService` | `JoinQuiz` | Unary | Player bergabung dengan kode quiz |
| `QuizService` | `SubmitAnswer` | Unary | Player mengirim jawaban |
| `QuizService` | `GetQuizResult` | Unary | Mengambil leaderboard final |
| `StreamService` | `WatchQuizEvents` | Server-streaming | Event: QUESTION_START, TIMER_TICK, ANSWER_REVEAL, PLAYER_JOINED, QUIZ_END |
| `StreamService` | `WatchLeaderboard` | Server-streaming | Leaderboard update real-time |
| `AdminService` | `UploadQuestions` | Client-streaming | Upload banyak soal sekaligus |
| `AdminService` | `StartQuiz` | Unary | Mulai quiz |
| `AdminService` | `NextQuestion` | Unary | Pindah ke soal berikutnya |
| `AdminService` | `EndQuiz` | Unary | Akhiri quiz |

### WebSocket Gateway

- **Bidirectional bridge**: menerjemahkan WebSocket JSON messages ke gRPC calls dan sebaliknya
- **Session management**: mapping session ↔ WebSocket connections via Maps
- **Server-side timer**: countdown per soal yang di-broadcast ke semua client
- **Live answer stats**: progress bar di host (X/Y pemain sudah menjawab)
- **Real-time player list**: broadcast PLAYER_LIST_UPDATE pada join/leave/kick/rejoin
- **Peer answer status**: siapa yang sudah menjawab vs yang belum per soal
- **Spectator mode**: bergabung sebagai read-only viewer, tidak bisa submit answer, tidak muncul di leaderboard
- **Kick player**: host bisa mengeluarkan player dari sesi
- **Leave room**: player bisa keluar dari sesi (tidak bisa saat soal aktif)
- **Reconnection**: player yang terputus bisa rejoin otomatis (5 retry, 3s interval)
- **Extended leaderboard stats**: menampilkan Benar / Salah / Tidak Dijawab per pemain
- **Spectator filtering**: spectator dikecualikan dari semua data leaderboard

### Frontend (Duolingo-Inspired)

- **Nunito font**, rounded corners, 3D button press effect (`box-shadow: 0 4px 0`)
- **Color system**: Yellow primary, green success, red error, blue info, purple accent
- **Animations**: `pop-in`, `slide-up`, timer pulse when ≤5s
- **Host panel**: quiz code display, timer, answer stats, leaderboard (medals), player list (kick), spectator count badge, activity log (emoji icons), control bar
- **Player panel**: mobile-first single-column, join/spectate cards, waiting room (pulsing rings), question + timer, answer buttons (A/B/C/D colored badges), feedback cards, peer status, leaderboard (own row highlighted), reconnect banner, kicked overlay
- **Font Awesome 6 icons** instead of emojis for cross-platform consistency

## WebSocket Protocol

All messages use JSON: `{ "type": "EVENT_NAME", "payload": { ... } }`

### Commands (Browser → Gateway)

| Command | gRPC Call | Description |
|---|---|---|
| `CREATE_QUIZ` | `QuizService.CreateQuiz` | Host membuat quiz |
| `UPLOAD_QUESTIONS` | `AdminService.UploadQuestions` | Host upload soal (client-streaming) |
| `JOIN_QUIZ` | `QuizService.JoinQuiz` | Player bergabung |
| `SUBMIT_ANSWER` | `QuizService.SubmitAnswer` | Player mengirim jawaban |
| `CONTROL_QUIZ` | `AdminService.StartQuiz/NextQuestion/EndQuiz` | Host: start / next / end |
| `GET_RESULT` | `QuizService.GetQuizResult` | Host mengambil leaderboard final |
| `LEAVE_QUIZ` | — | Player keluar dari room |
| `REJOIN_QUIZ` | — | Player reconnect setelah disconnect |
| `JOIN_AS_SPECTATOR` | — | Bergabung sebagai spectator (read-only) |
| `KICK_PLAYER` | — | Host mengeluarkan player |

### Events (Gateway → Browser)

| Event | Source | Description |
|---|---|---|
| `QUIZ_CREATED` | CreateQuiz response | quiz_code, session_id, host_id |
| `JOIN_SUCCESS` | JoinQuiz response | player_id, session_id |
| `SPECTATOR_JOIN_SUCCESS` | — | Spectator join dengan full state |
| `QUIZ_EVENT` | gRPC stream | Soal, jawaban reveal, dll |
| `LEADERBOARD_UPDATE` | gRPC stream (filtered) | Leaderboard real-time (spectator excluded) |
| `TIMER_TICK` | Gateway timer | Countdown setiap detik |
| `TIMER_EXPIRED` | Gateway timer | Waktu habis |
| `ANSWER_RESULT` | SubmitAnswer response | Benar/salah + skor |
| `ANSWER_STATS` | Gateway counter | Progress bar data (host only) |
| `PEER_ANSWER_STATUS` | Gateway counter | Siapa sudah/belum menjawab |
| `PLAYER_LIST_UPDATE` | Gateway | Daftar pemain terbaru |
| `PLAYER_JOINED` | gRPC stream | Notifikasi player bergabung |
| `PLAYER_LEFT` | Gateway | Player keluar |
| `PLAYER_KICKED` | Gateway | Player dikeluarkan oleh host |
| `PLAYER_REJOINED` | Gateway | Player reconnect |
| `SPECTATOR_JOINED` | Gateway | Spectator bergabung (host only) |
| `SPECTATOR_LEFT` | Gateway | Spectator keluar (host only) |
| `QUIZ_ENDED` | gRPC stream + GetQuizResult | Leaderboard final + pemenang |
| `QUIZ_RESULT` | GetQuizResult | Hasil final on demand |
| `LEAVE_CONFIRMED` | — | Konfirmasi keluar |
| `REJOIN_SUCCESS` | — | Konfirmasi reconnect |
| `YOU_WERE_KICKED` | — | Player dikeluarkan |
| `ERROR` | Error handler | Pesan error |

## Gateway Data Structures

| Variable | Type | Purpose |
|---|---|---|
| `sessionClients` | `Map<sessionId, Set<WebSocket>>` | Semua WS connections per session |
| `clientMeta` | `Map<WebSocket, Object>` | Metadata per koneksi: session_id, role, player_name, dll |
| `streamSubs` | `Map<sessionId, {eventStream, leaderboardStream}>` | gRPC stream subscriptions per session |
| `sessionTimers` | `Map<sessionId, {remaining, total, interval}>` | Countdown timer per session |
| `playerSessions` | `Map<"name:QUIZCODE", Object>` | Reconnect state untuk player |
| `answerStats` | `Map<sessionId, {total, answered}>` | Counter jawaban per soal (host stats) |
| `sessionState` | `Map<sessionId, Object>` | Per-session: quizStatus, currentQuestion, lastLeaderboard, totalQuestions |
| `sessionPlayers` | `Map<sessionId, Set<string>>` | Nama player per session |
| `sessionSpectators` | `Map<sessionId, Set<string>>` | Nama spectator per session (excluded from leaderboard) |
| `sessionAnsweredPlayers` | `Map<sessionId, Set<string>>` | Nama player yang sudah menjawab soal saat ini |
| `quizCodeToSessionId` | `Map<quizCode, sessionId>` | Lookup untuk spectator/rejoin |
| `playerStats` | `Map<sessionId, Map<playerName, {correct, wrong, unanswered}>>` | Stats per player untuk leaderboard enrichment |

## Leaderboard & Spectator Filtering

Spectator names are tracked in `sessionSpectators` and excluded from all leaderboard data paths:

1. **LEADERBOARD_UPDATE** — gRPC stream entries are enriched with stats, filtered by `filterLeaderboardEntries()`, and ranks recalculated
2. **buildLeaderboardEntries()** — Used in QUIZ_END; scores from gRPC are filtered via `isSpectator()` before building entries
3. **QUIZ_ENDED** — Final leaderboard built from `buildLeaderboardEntries()` (already player-only since `sessionPlayers` excludes spectators)
4. **GET_RESULT (QUIZ_RESULT)** — gRPC leaderboard filtered by `isSpectator()`, ranks recalculated
5. **SPECTATOR_JOIN_SUCCESS** — Initial leaderboard data filtered by `filterLeaderboardEntries()`
6. **REJOIN_SUCCESS** — Restored leaderboard data stored pre-filtered (non-spectator entries only)

## Scoring

- Jawaban benar: `max(100 - floor(elapsed_seconds) * 5, 10)` poin
- Jawaban salah: 0 poin
- Tiebreaker: lebih banyak `correct_answers` menang, lalu alphabetical

## Error Handling (gRPC)

| Status Code | Kondisi |
|---|---|
| `INVALID_ARGUMENT` | Field wajib kosong / format invalid |
| `NOT_FOUND` | Quiz, session, atau player tidak ditemukan |
| `FAILED_PRECONDITION` | State tidak cocok (join saat aktif, jawaban setelah end) |
| `ALREADY_EXISTS` | Nama player duplikat / jawaban ganda |
| `PERMISSION_DENIED` | Aksi admin oleh host yang tidak sah |
| `DEADLINE_EXCEEDED` | Jawaban dikirim setelah waktu habis |

## Requirement Completion Check

### 1. Implementasi WebSocket — ✅ PASS

> *Wajib menghubungkan fitur Streaming gRPC yang sudah ada ke WebSocket. Data yang mengalir di gRPC stream harus ditampilkan secara otomatis di Web UI.*

Gateway meng-subscribe dua gRPC server-stream per session dan mem-forward datanya ke browser secara proaktif:

| gRPC Stream | Gateway Handler | WS Event | UI Target |
|---|---|---|---|
| `WatchQuizEvents` | `subscribeStreamsForSession()` | `QUIZ_EVENT` | host.html `handleQuizEvent()`, player.html `handleQuizEvent()` |
| `WatchLeaderboard` | `subscribeStreamsForSession()` | `LEADERBOARD_UPDATE` | host.html `renderLeaderboard()`, player.html `renderLeaderboard()` |

Data mengalir otomatis — setiap kali gRPC stream mengirim update, gateway langsung broadcast ke semua WebSocket client terdaftar tanpa request dari browser.

---

### 2. Event-Driven UI — ✅ PASS (7+ komponen di host, 6+ di player)

> *Minimal terdapat 3 komponen di UI yang berubah secara dinamis berdasarkan pesan dari WebSocket.*

**Host (`host.html`):**

| # | Komponen | Perubahan Dinamis | Trigger WS Event |
|---|---|---|---|
| 1 | Leaderboard table | Re-render seluruh tabel (rank, nama, skor, benar/salah/tidak dijawab) | `LEADERBOARD_UPDATE` |
| 2 | Timer display | Angka countdown + perubahan warna (hijau→kuning→merah+pulse) | `TIMER_TICK`, `TIMER_EXPIRED` |
| 3 | Answer stats progress bar | Lebar progress bar + teks "3/5 pemain (60%)" | `ANSWER_STATS` |
| 4 | Player list | Re-render daftar pemain + badge "In Room" + kick button | `PLAYER_LIST_UPDATE` |
| 5 | Activity log | Prepends timestamped log entries dengan ikon | Semua event via `log()` |
| 6 | Status badge | Berubah: Menunggu (kuning) → Berlangsung (hijau) → Selesai (abu) | `QUIZ_EVENT`, `CONTROL_RESULT`, `UPLOAD_RESULT` |
| 7 | Control buttons | Enable/disable berdasarkan state (Start→Next+End→Hasil) | `CONTROL_RESULT`, `UPLOAD_RESULT`, `QUIZ_ENDED` |

**Player (`player.html`):**

| # | Komponen | Perubahan Dinamis | Trigger WS Event |
|---|---|---|---|
| 1 | Leaderboard | Re-render tabel leaderboard (highlight baris sendiri) | `LEADERBOARD_UPDATE` |
| 2 | Timer (circle + progress bar) | Countdown angka + warna transisi | `TIMER_TICK` |
| 3 | Answer buttons | 4 opsi tampil, disable setelah pilih | `QUIZ_EVENT` (QUESTION_START) |
| 4 | Feedback card | Pop-in animasi: hijau (benar), merah (salah), kuning (waktu habis) | `ANSWER_RESULT`, `TIMER_EXPIRED` |
| 5 | Peer status panel | Dua kolom: "Sudah menjawab" vs "Menunggu" | `PEER_ANSWER_STATUS` |
| 6 | Spectator badge | Menampilkan "👁 Spectator Mode" di atas | `SPECTATOR_JOIN_SUCCESS` |

---

### 3. Server-Initiated Events — ✅ PASS (11 event proaktif)

> *Server harus bisa mendorong data secara proaktif ke browser tanpa ada permintaan dari klien.*

Semua event berikut dikirim oleh server ke browser **tanpa** request/trigger dari browser — murni dari gRPC stream, gateway timer, atau gateway internal logic:

| # | Event | Trigger di Server | Efek di Browser |
|---|---|---|---|
| 1 | `LEADERBOARD_UPDATE` | gRPC `WatchLeaderboard` stream fires after setiap jawaban | Leaderboard re-render secara otomatis |
| 2 | `QUIZ_EVENT` (QUESTION_START) | gRPC stream fires saat host mulai/next soal | Soal + timer muncul otomatis |
| 3 | `QUIZ_EVENT` (ANSWER_REVEAL) | gRPC stream fires setelah soal selesai | Jawaban benar ditampilkan |
| 4 | `QUIZ_EVENT` (QUIZ_END) | gRPC stream fires saat host akhiri quiz | Halaman hasil final |
| 5 | `TIMER_TICK` | Gateway `setInterval` setiap 1 detik | Countdown update otomatis |
| 6 | `TIMER_EXPIRED` | Gateway timer menyentuh 0 | "Waktu habis" feedback |
| 7 | `PLAYER_JOINED` | gRPC stream fires saat player baru join | Activity log + notifikasi |
| 8 | `PLAYER_LIST_UPDATE` | Gateway broadcasts saat join/leave/kick/rejoin | Player list re-render |
| 9 | `SPECTATOR_JOINED/LEFT` | Gateway pushes ke host saat spectator join/leave | Spectator count badge update |
| 10 | `ANSWER_STATS` | Gateway pushes setiap `SUBMIT_ANSWER` | Progress bar update (host) |
| 11 | `PEER_ANSWER_STATUS` | Gateway broadcasts setelah setiap jawaban | "Sudah/Menunggu" lists |

---

### 4. Command & Control Bridge — ✅ PASS (6 gRPC bridges + 4 gateway commands)

> *Browser harus mampu mengirim instruksi via WebSocket yang secara otomatis memicu pemanggilan fungsi gRPC di layanan back-end.*

**gRPC Bridge Commands (browser → WS → gateway → gRPC):**

| # | Browser Command | Gateway Handler | gRPC Call |
|---|---|---|---|
| 1 | `CREATE_QUIZ` | `handleCreateQuiz()` | `QuizService.CreateQuiz` (unary) |
| 2 | `UPLOAD_QUESTIONS` | `handleUploadQuestions()` | `AdminService.UploadQuestions` (client-streaming) |
| 3 | `JOIN_QUIZ` | `handleJoinQuiz()` | `QuizService.JoinQuiz` (unary) |
| 4 | `SUBMIT_ANSWER` | `handleSubmitAnswer()` | `QuizService.SubmitAnswer` (unary) |
| 5 | `CONTROL_QUIZ` | `handleControlQuiz()` | `AdminService.StartQuiz` / `NextQuestion` / `EndQuiz` (unary) |
| 6 | `GET_RESULT` | `handleGetResult()` | `QuizService.GetQuizResult` (unary) |

**Gateway-Managed Commands (browser → WS → gateway internal logic, no gRPC needed):**

| # | Browser Command | Gateway Handler | Action |
|---|---|---|---|
| 7 | `JOIN_AS_SPECTATOR` | `handleJoinAsSpectator()` | Tambah spectator ke session, kirim state lengkap |
| 8 | `LEAVE_QUIZ` | `handleLeaveQuiz()` | Hapus dari session, broadcast ke semua client |
| 9 | `REJOIN_QUIZ` | `handleRejoinQuiz()` | Restore player state setelah disconnect |
| 10 | `KICK_PLAYER` | `handleKickPlayer()` | Hapus player, kirim `YOU_WERE_KICKED`, tutup WS |

---

## Drawbacks

1. **No persistence** — All state in-memory; gateway restart = semua session hilang
2. **No authentication** — Host validation hanya berdasarkan `ws.isHost`
3. **Single-server** — No horizontal scaling; semua state dalam satu proses
4. **gRPC stream lifecycle** — Stream subscriptions per-session; error pada stream mempengaruhi semua client
5. **Player name collisions** — Dua player dengan nama sama di session yang sama menyebabkan masalah
6. **Timer drift** — `setInterval` bisa drift under load (tidak masalah untuk 15-20 detik)