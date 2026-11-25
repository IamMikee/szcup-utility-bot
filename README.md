# AZHEN — SZCUP '26 Discord Tournament Bot

**AZHEN** (`szcup-bot`) is a single-guild Discord tournament utility bot built for **SZCUP '26**. It integrates directly with Firebase Firestore (connected to the `ppitshenzhen` registration system) to handle automated player verification, dynamic Discord role assignment, private match voice channel orchestration, and tournament bracket progression.

---

## ✨ Features

- **Automated Player Verification**: Cross-references player names and ticket codes against Firestore registration form responses, assigning team and game roles while marking tickets as checked in.
- **Dynamic Match Orchestration**: Spawns isolated, temporary voice channels and temporary match roles for PvP matchups with interactive roster confirmation and modification modals.
- **Automated Cleanup**: Disconnects players, strips temporary match roles, and deletes temporary voice channels upon match completion—plus automatic orphan cleanup on bot restarts.
- **Bracket & Progression Tracking**: Tracks qualifier, quarterfinal, semifinal, and finalist progressions alongside automated server announcements.
- **Comprehensive Audit Logging**: Logs every administrative action, verification, match setup, and cleanup event to a dedicated audit channel.

---

## 🛠️ Tech Stack

- **Runtime**: Node.js 18+ (CommonJS)
- **Discord Library**: `discord.js` v14
- **Database**: Firebase Admin SDK (`firebase-admin` v12+) / Cloud Firestore
- **Configuration**: `dotenv`

---

## 🚀 Getting Started

### 1. Prerequisites
- [Node.js](https://nodejs.org/) v18 or higher
- A Discord Bot Application with **Server Members Intent** enabled in the Discord Developer Portal
- A Firebase project with Firestore enabled and a Service Account key

### 2. Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/your-username/szcup-bot.git
cd szcup-bot
npm install
```

### 3. Environment Configuration

Create a `.env` file in the root directory based on `.env.example`:

```env
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_application_client_id
DISCORD_GUILD_ID=your_target_server_id

# Single-line JSON string of your Firebase Service Account credentials
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}

# Discord Role & Channel IDs
ADMIN_ROLE_ID=role_id_for_bot_admins
AUDIT_CHANNEL_ID=channel_id_for_audit_logs
ANNOUNCEMENT_CHANNEL_ID=channel_id_for_bracket_announcements

# Firestore Form Mapping
NAME_ANSWER_IDS=ansId1,ansId2,ansId3
GAME_ANSWER_ID=ansGameId
```

> **Note**: `FIREBASE_SERVICE_ACCOUNT` must be formatted as a valid single-line JSON string. Do not commit `.env` or service account files to version control.

### 4. Deploy Commands & Run

Register the slash commands to your Discord server (guild-scoped for instant availability):

```bash
npm run deploy
```

*(Optional)* Seed test ticket and form response data into Firestore for local QA:

```bash
npm run seed
```

Start the bot:

```bash
npm start
```

---

## 📋 Command Reference

### Public Commands
Available to all members in the server.

| Command | Usage | Description |
| :--- | :--- | :--- |
| **`/verify`** | `/verify [full name] [ticket code]` | Verifies a registered player (ephemeral response), assigns their Game and Team roles, and marks the ticket checked in. Name must match registration spelling. |
| **`/check-ticket`** | `/check-ticket [ticket code]` | Displays a team's game, bracket stage, match record, and roster verification status (`✅` verified / `⬜` unverified). |
| **`/check-player`** | `/check-player [@user]` | Displays all teams a user is verified for along with their tournament stage and match history. |

### Admin Commands
Restricted to users with the configured `ADMIN_ROLE_ID` (or granted via `/admin`). All actions are logged to the audit channel.

#### Match Management
| Command | Usage | Description |
| :--- | :--- | :--- |
| **`/set-match-vc-channel`** | `/set-match-vc-channel [voice channel]` | Sets the template voice channel. Temporary match VCs will be created inside this channel's category. |
| **`/start-match`** | `/start-match [team A code] [team B code]` | Initiates a PvP match setup with interactive **Confirm**, **Modify** (add/remove players via modal), and **Cancel** buttons (3-minute timeout). |
| **`/finish-match`** | `/finish-match [match voice channel]` | Ends an active match, disconnects players from voice, removes/deletes the temporary match role, and deletes the temp VC. |

#### Bracket & Player Administration
| Command | Usage | Description |
| :--- | :--- | :--- |
| **`/win`** | `/win [ticket code] [promote-to-qf]` | Records a win. Use `promote-to-qf: true` to advance from qualifiers to quarterfinals; subsequent wins advance through semifinals to finalist and post announcements. |
| **`/lose`** | `/lose [ticket code]` | Records a loss, marks the team as eliminated, and posts an elimination announcement. |
| **`/clean-role`** | `/clean-role [ticket code] [@user]` | Resets verification records and removes team/game roles for a specific player (or the entire team if `@user` is omitted) so they can re-verify. Blocked during active matches. |
| **`/admin`** | `/admin [@user]` | Toggles bot admin access for a user. Includes safeguards against self-demotion, bot promotion, and removing the last admin. |

---

## 🗂️ Project Structure

```text
szcup-utility-bot/
├── commands/                 # Slash command definitions and handlers
│   ├── admin.js
│   ├── check-player.js
│   ├── check-ticket.js
│   ├── clean-role.js
│   ├── finish-match.js
│   ├── lose.js
│   ├── set-match-vc-channel.js
│   ├── start-match.js
│   ├── verify.js
│   └── win.js
├── config/
│   └── colors.js             # Standardized embed hex colors
├── events/                   # Discord gateway event listeners
│   ├── guildMemberAdd.js     # Strips roles on join
│   ├── interactionCreate.js  # Routes commands, buttons, and modals
│   └── ready.js              # Sets status & cleans orphaned VCs/roles on boot
├── lib/                      # Shared utilities & Firestore helpers
│   ├── audit.js
│   ├── firebase.js
│   ├── form.js
│   ├── guards.js
│   ├── match.js
│   ├── names.js
│   └── roles.js
├── deploy-commands.js        # Guild slash-command registration script
├── index.js                  # Application entry point
├── dupe-ticket.js           # Firestore QA data seeding script (create, clone, delete)
└── package.json
```

---

## 🗄️ Firestore Collections

- **`tickets/{ticketCode}`** *(Read / Check-in Write)*: Source registration data linked to `ppitshenzhen`. Updated with `checkedIn: true` on first player verification.
- **`forms/{formId}/responses/{responseId}`** *(Read-only)*: Registration form submissions containing team player names and selected game.
- **`verifications/{autoId}`**: Maps Discord user IDs to verified ticket codes and normalized player names.
- **`active_matches/{matchId}`**: Tracks live match voice channels, temporary roles, and rosters. Automatically wiped on bot restart alongside orphaned Discord channels/roles.
- **`brackets/{ticketCode}`**: Stores current bracket stage (`qf`, `sf`, `completed`), elimination status, and match history.
- **`config/match_settings`**: Stores the template voice channel ID for match category placement.