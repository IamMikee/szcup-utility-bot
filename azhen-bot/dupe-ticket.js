// dupe-ticket.js
require('dotenv').config();
const readline = require('readline');
const { admin, db } = require('./lib/firebase');

const Timestamp = admin.firestore.Timestamp;
const NAME_IDS = (process.env.NAME_ANSWER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const GAME_ID = process.env.GAME_ANSWER_ID;

const ts = (iso) => Timestamp.fromDate(new Date(iso));

// ─────────────────────────────────────────────────────────────────────────────
// Existing dupe logic
// ─────────────────────────────────────────────────────────────────────────────

async function deleteDupe(code) {
    const ref = db.collection('tickets').doc(code);
    const snap = await ref.get();
    if (!snap.exists) {
        console.log(`Ticket ${code} does not exist. Nothing to delete.`);
        return;
    }
    const vers = await db.collection('verifications').where('ticketCode', '==', code).get();
    if (!vers.empty) {
        const batch = db.batch();
        vers.docs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
    }
    await ref.delete();
    console.log(`Deleted tickets/${code} and ${vers.size} verification doc(s).`);
}

async function dupe(sourceCode, newCode) {
    if (!/^[A-Z0-9]{8}$/.test(newCode)) {
        console.error(`NEW_CODE "${newCode}" must be exactly 8 uppercase alphanumeric chars.`);
        process.exit(1);
    }
    const srcRef = db.collection('tickets').doc(sourceCode);
    const srcSnap = await srcRef.get();
    if (!srcSnap.exists) {
        console.error(`Source ticket ${sourceCode} does not exist.`);
        process.exit(1);
    }
    const newRef = db.collection('tickets').doc(newCode);
    const existing = await newRef.get();
    if (existing.exists) {
        console.error(
            `Target ticket ${newCode} already exists.\n` +
            `Delete it first: node dupe-ticket.js --delete ${newCode}`
        );
        process.exit(1);
    }
    const src = srcSnap.data();
    const dupeDoc = {
        ...src,
        code: newCode,
        checkedIn: false,
        checkedInAt: null,
        checkedInBy: null,
    };
    await newRef.set(dupeDoc);
    console.log(`✅ Created tickets/${newCode} as a dupe of tickets/${sourceCode}.`);
    console.log(`   Form response (read-only, shared): forms/${src.formId}/responses/${src.responseId}`);
    console.log(`   Original ticket ${sourceCode} is UNTOUCHED.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Interactive create
// ─────────────────────────────────────────────────────────────────────────────

function makePrompter() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const ask = (question, defaultValue) =>
        new Promise((resolve) => {
            const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : '';
            rl.question(`${question}${suffix}: `, (raw) => {
                const trimmed = raw.trim();
                resolve(trimmed !== '' ? trimmed : defaultValue !== undefined ? String(defaultValue) : '');
            });
        });

    const askRequired = async (question) => {
        while (true) {
            const v = await ask(question);
            if (v !== '') return v;
            console.log('  ✗ Required — cannot be empty.');
        }
    };

    const askNullable = async (question) => {
        const v = await ask(`${question} (empty = null)`);
        return v === '' || v.toLowerCase() === 'null' ? null : v;
    };

    const askYesNo = async (question, defaultYes = false) => {
        while (true) {
            const v = (await ask(`${question} (y/n)`, defaultYes ? 'y' : 'n')).toLowerCase();
            if (['y', 'yes'].includes(v)) return true;
            if (['n', 'no'].includes(v)) return false;
            console.log('  ✗ Please type y or n.');
        }
    };

    const askIsoDate = async (question) => {
        while (true) {
            const v = await ask(`${question} (ISO or "now")`, 'now');
            const d = v.toLowerCase() === 'now' ? new Date() : new Date(v);
            if (!isNaN(d.getTime())) return d;
            console.log('  ✗ Invalid date. Try 2026-11-20T14:58:49Z or "now".');
        }
    };

    const askCode = async () => {
        while (true) {
            const v = (await ask('Ticket code (8 uppercase alnum)')).toUpperCase();
            if (/^[A-Z0-9]{8}$/.test(v)) return v;
            console.log('  ✗ Must be exactly 8 alphanumeric characters.');
        }
    };

    return { ask, askRequired, askNullable, askYesNo, askIsoDate, askCode, close: () => rl.close() };
}

async function createInteractive() {
    if (!NAME_IDS.length || !GAME_ID) {
        console.error('NAME_ANSWER_IDS and GAME_ANSWER_ID must be set in .env.');
        process.exit(1);
    }

    const p = makePrompter();

    try {
        console.log('\n=== Create new ticket (interactive) ===');
        console.log('Press Enter to accept a default shown in [brackets].\n');

        // ── Ticket doc ───────────────────────────────────────────────────────────
        const code = await p.askCode();

        const existing = await db.collection('tickets').doc(code).get();
        if (existing.exists) {
            const overwrite = await p.askYesNo(`  tickets/${code} already exists. Overwrite?`, false);
            if (!overwrite) {
                console.log('Aborted. Nothing written.');
                return;
            }
        }

        const name = await p.askRequired('Leader full name');
        const email = await p.askRequired('Email');
        const formId = await p.askRequired('formId');
        const responseId = await p.askRequired('responseId');
        const uid = await p.askRequired('uid');
        const emailStatus = await p.ask('emailStatus', 'sent');
        const emailError = await p.askNullable('emailError');
        const createdAt = await p.askIsoDate('createdAt');
        const emailSentAt = await p.askIsoDate('emailSentAt');

        const ticketDoc = {
            // Bot-managed — excluded from prompts:
            checkedIn: false,
            checkedInAt: null,
            checkedInBy: null,

            // User-provided:
            code,
            createdAt: Timestamp.fromDate(createdAt),
            email,
            emailError,
            emailSentAt: Timestamp.fromDate(emailSentAt),
            emailStatus,
            formId,
            name,
            responseId,
            uid,
        };

        // ── Form response ────────────────────────────────────────────────────────
        console.log('\n=== Form response ===');
        const formRef = db.collection('forms').doc(formId).collection('responses').doc(responseId);
        const formSnap = await formRef.get();

        let answers = null;
        if (formSnap.exists) {
            console.log(`  forms/${formId}/responses/${responseId} already exists.`);
            const overwrite = await p.askYesNo('  Overwrite with new answers? (no = reuse as-is)', false);
            if (overwrite) answers = await promptAnswers(p);
        } else {
            console.log(`  Does not exist — will create it.`);
            answers = await promptAnswers(p);
        }

        // ── Summary & confirm ────────────────────────────────────────────────────
        console.log('\n=== Summary ===');
        console.log(JSON.stringify(
            {
                ticket: {
                    ...ticketDoc,
                    createdAt: createdAt.toISOString(),
                    emailSentAt: emailSentAt.toISOString(),
                },
                formResponse: answers ?? '(reusing existing)',
            },
            null,
            2
        ));

        const confirm = await p.askYesNo('\nWrite to Firestore?', false);
        if (!confirm) {
            console.log('Aborted. Nothing written.');
            return;
        }

        await db.collection('tickets').doc(code).set(ticketDoc);
        console.log(`✅ tickets/${code}`);

        if (answers) {
            await formRef.set({ answers }, { merge: true });
            console.log(`✅ forms/${formId}/responses/${responseId}`);
        }

        console.log('\nDone. You can now run /verify against the new ticket.');
    } finally {
        p.close();
    }
}

async function promptAnswers(p) {
    const answers = {};
    answers[GAME_ID] = await p.askRequired('Game (e.g. Mobile Legends)');
    for (let i = 0; i < NAME_IDS.length; i++) {
        const n = await p.ask(`Player name ${i + 1} (${NAME_IDS[i]})`);
        if (n) answers[NAME_IDS[i]] = n;
    }
    return answers;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

(async () => {
    if (args[0] === '--delete') {
        if (!args[1]) {
            console.error('Usage: node dupe-ticket.js --delete <CODE>');
            process.exit(1);
        }
        await deleteDupe(args[1]);
        return;
    }

    if (args[0] === '--create' || args[0] === '--new') {
        await createInteractive();
        return;
    }

    if (args.length < 2) {
        console.error('Usage:');
        console.error('  node dupe-ticket.js --create                  # interactive new ticket');
        console.error('  node dupe-ticket.js <SOURCE_CODE> <NEW_CODE>  # duplicate a ticket');
        console.error('  node dupe-ticket.js --delete <CODE>           # delete a ticket + verifications');
        process.exit(1);
    }

    await dupe(args[0], args[1]);
})().catch((e) => {
    console.error('Failed:', e);
    process.exit(1);
});