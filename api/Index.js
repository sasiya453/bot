// api/index.js
import { createClient } from '@supabase/supabase-js';
import { format, subDays } from 'date-fns';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // service role key
const CHANNEL_ID = process.env.CHANNEL_ID; // e.g. -1001234567890
const ADMIN_ID = process.env.ADMIN_ID; // your telegram user id as string

if (!TELEGRAM_BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing required env vars.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false }});
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

function tgSend(method, body) {
  return fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(r => r.json());
}

function makeMainMenuKeyboard() {
  return {
    reply_markup: JSON.stringify({
      inline_keyboard: [
        [{ text: 'My Profile', callback_data: 'MENU_PROFILE' }],
        [{ text: 'Top 10', callback_data: 'MENU_TOP10' }],
        [{ text: 'Today Submission', callback_data: 'MENU_TODAY' }],
        [{ text: 'Old Date Submission', callback_data: 'MENU_OLD' }]
      ]
    })
  };
}

function parseDurationFromText(text) {
  // find first number, integer or decimal
  if (!text) return null;
  const re = /(\d+(?:\.\d+)?)/;
  const m = text.match(re);
  if (!m) return null;
  return parseFloat(m[1]);
}

async function ensureUser(telegram_id, nameFromTelegram = null) {
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  if (error) throw error;
  if (user) return user;

  // create new user stub and set state to REG_NAME
  const { data, error: insertErr } = await supabase
    .from('users')
    .insert([{ telegram_id, real_name: nameFromTelegram, bot_state: 'REG_NAME' }])
    .select()
    .single();

  if (insertErr) throw insertErr;
  return data;
}

async function setUserState(telegram_id, state, temp_data = null) {
  const upd = { bot_state: state };
  if (temp_data !== null) upd.temp_data = temp_data;
  const { error } = await supabase.from('users').update(upd).eq('telegram_id', telegram_id);
  if (error) console.error('setUserState error', error);
}

async function updateUserFields(telegram_id, fields) {
  const { error } = await supabase.from('users').update(fields).eq('telegram_id', telegram_id);
  if (error) console.error('updateUserFields error', error);
}

async function getLast7DaysData(telegram_id) {
  const to = new Date();
  const from = subDays(to, 6);
  const fromStr = format(from, 'yyyy-MM-dd');
  const toStr = format(to, 'yyyy-MM-dd');
  const { data, error } = await supabase
    .from('study_logs')
    .select('study_date,duration')
    .eq('telegram_id', telegram_id)
    .gte('study_date', fromStr)
    .lte('study_date', toStr)
    .order('study_date', { ascending: true });

  if (error) throw error;
  // build map date->sum
  const map = {};
  for (let i = 0; i < 7; i++) {
    const d = format(subDays(to, 6 - i), 'yyyy-MM-dd');
    map[d] = 0;
  }
  for (const r of data) {
    const k = format(new Date(r.study_date), 'yyyy-MM-dd');
    map[k] = (map[k] || 0) + Number(r.duration);
  }
  const labels = Object.keys(map);
  const values = labels.map(d => Number(map[d]));
  return { labels, values };
}

function quickChartUrl(labels, values, title = 'Study Hours (last 7 days)') {
  // QuickChart accepts JSON config in URL; keep compact
  const chart = {
    type: 'line',
    data: { labels, datasets: [{ label: 'Hours', data: values, fill: false }] },
    options: { plugins: { title: { display: true, text: title } }, scales: { y: { beginAtZero: true } } }
  };
  const qc = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chart))}&format=png&width=800&height=350`;
  return qc;
}

async function handleCallbackQuery(callbackQuery) {
  const { id, from, data, message } = callbackQuery;
  const chatId = message.chat.id;
  const telegram_id = from.id;
  const user = await ensureUser(telegram_id, from.first_name + (from.last_name ? ' ' + from.last_name : ''));

  if (data === 'MENU_PROFILE') {
    // show profile and buttons: Edit | Line Chart | Home
    const { data: totalResult } = await supabase.rpc('get_user_total_hours', { p_telegram_id: telegram_id }).catch(()=>({data:null}));
    const totalHours = totalResult ? totalResult.total_hours : null;
    const profileText = `Username: ${user.username || '-'}\nName: ${user.real_name || '-'}\nTotal Hours (All time): ${totalHours ?? '0'}`;
    await tgSend('answerCallbackQuery', { callback_query_id: id });
    await tgSend('sendMessage', {
      chat_id: chatId,
      text: profileText,
      ...{
        reply_markup: JSON.stringify({
          inline_keyboard: [
            [{ text: 'Edit', callback_data: 'PROFILE_EDIT' }],
            [{ text: 'Line Chart', callback_data: 'PROFILE_LINE' }],
            [{ text: 'Home', callback_data: 'MENU_HOME' }]
          ]
        })
      }
    });
  } else if (data === 'MENU_TOP10') {
    // fetch top 10 view
    const { data: ranks, error } = await supabase.from('user_ranks').select('*').limit(10);
    let text = 'Top 10 This Week (All-time aggregated for now):\n';
    if (error) text = 'Error loading leaderboard';
    else {
      ranks.forEach((r, idx) => { text += `${idx+1}. ${r.name || r.telegram_id} — ${r.total_hours} hrs\n`; });
    }
    await tgSend('answerCallbackQuery', { callback_query_id: id });
    await tgSend('sendMessage', { chat_id: chatId, text, reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Home', callback_data: 'MENU_HOME' }]] }) });
  } else if (data === 'MENU_TODAY') {
    // set state to AWAITING_SUBMISSION with study_date = today in temp_data
    const study_date = format(new Date(), 'yyyy-MM-dd');
    await setUserState(telegram_id, 'AWAITING_SUBMISSION', { study_date });
    await tgSend('answerCallbackQuery', { callback_query_id: id, text: 'Please send a photo with caption like "Maths 2.5 hours" to submit for today.' });
  } else if (data === 'MENU_OLD') {
    // ask year
    await setUserState(telegram_id, 'AWAITING_OLD_YEAR', {});
    await tgSend('answerCallbackQuery', { callback_query_id: id });
    await tgSend('sendMessage', { chat_id: chatId, text: 'Send YEAR (e.g., 2025) for the old date submission. Or /cancel to go back.' });
  } else if (data === 'PROFILE_LINE') {
    // send line chart for user last 7 days
    await tgSend('answerCallbackQuery', { callback_query_id: id });
    const { labels, values } = await getLast7DaysData(telegram_id);
    const url = quickChartUrl(labels, values);
    await tgSend('sendPhoto', { chat_id: chatId, photo: url, caption: 'Your last 7 days study hours' });
  } else if (data === 'MENU_HOME') {
    await tgSend('answerCallbackQuery', { callback_query_id: id });
    await tgSend('sendMessage', Object.assign({ chat_id: chatId, text: 'Main Menu' }, makeMainMenuKeyboard()));
  } else if (data === 'PROFILE_EDIT') {
    await setUserState(telegram_id, 'EDITING_PROFILE', {});
    await tgSend('answerCallbackQuery', { callback_query_id: id });
    await tgSend('sendMessage', { chat_id: chatId, text: 'Send your new display username (or real name) to update profile.' });
  } else if (data === 'DRAFT_SUBMIT') {
    // used when confirming draft submission - callback contains "DRAFT_SUBMIT:{draftId}"? but in our approach we'll use inline payloadless flow
    await tgSend('answerCallbackQuery', { callback_query_id: id, text: 'Submit clicked (this flow uses inline Confirm/Cancel in messages).' });
  } else {
    await tgSend('answerCallbackQuery', { callback_query_id: id, text: 'Unknown action' });
  }
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const telegram_id = message.from.id;
  const text = message.text ?? '';
  const user = await ensureUser(telegram_id, (message.from.first_name || '') + (message.from.last_name ? ' ' + message.from.last_name : ''));

  // admin commands
  if (text && text.startsWith('/users') && String(telegram_id) === String(ADMIN_ID)) {
    // list all users + totals
    const { data } = await supabase.from('user_ranks').select('*').limit(200);
    let out = 'All users:\n';
    data.forEach(u => { out += `${u.name} (${u.telegram_id}) — ${u.total_hours} hrs\n`; });
    await tgSend('sendMessage', { chat_id: chatId, text: out });
    return;
  }

  // /start — registration entrypoint
  if (text === '/start') {
    // ensure user created above, then if in REG_NAME ask for full name
    if (user.bot_state === 'REG_NONE' || user.bot_state === 'REG_NAME') {
      await setUserState(telegram_id, 'REG_NAME', {});
      await tgSend('sendMessage', { chat_id: chatId, text: 'Welcome! Please send your Full Name.' });
      return;
    } else {
      await tgSend('sendMessage', Object.assign({ chat_id: chatId, text: 'Welcome back! Main Menu' }, makeMainMenuKeyboard()));
      await setUserState(telegram_id, 'HOME', {});
      return;
    }
  }

  // /cancel — return to home
  if (text && text.trim().toLowerCase() === '/cancel') {
    await setUserState(telegram_id, 'HOME', {});
    await tgSend('sendMessage', Object.assign({ chat_id: chatId, text: 'Cancelled. Main Menu.' }, makeMainMenuKeyboard()));
    return;
  }

  // handle states
  const state = user.bot_state || 'HOME';

  if (state === 'REG_NAME') {
    // text is full name
    await updateUserFields(telegram_id, { real_name: text });
    await setUserState(telegram_id, 'REG_USERNAME', {});
    await tgSend('sendMessage', { chat_id: chatId, text: 'Thanks — now choose a username (short display name).' });
    return;
  }

  if (state === 'REG_USERNAME') {
    await updateUserFields(telegram_id, { username: text });
    await setUserState(telegram_id, 'REG_PASSWORD', {});
    await tgSend('sendMessage', { chat_id: chatId, text: 'Finally, set a password for verification (simple text is OK).' });
    return;
  }

  if (state === 'REG_PASSWORD') {
    await updateUserFields(telegram_id, { password: text });
    await setUserState(telegram_id, 'HOME', {});
    await tgSend('sendMessage', Object.assign({ chat_id: chatId, text: `Registration complete. Hello, ${text}!` }, makeMainMenuKeyboard()));
    return;
  }

  if (state === 'EDITING_PROFILE') {
    // update username or real_name
    await updateUserFields(telegram_id, { username: text });
    await setUserState(telegram_id, 'HOME', {});
    await tgSend('sendMessage', Object.assign({ chat_id, text: 'Profile updated.' }, makeMainMenuKeyboard()));
    return;
  }

  if (state === 'AWAITING_OLD_YEAR') {
    // expect year number
    const year = parseInt(text);
    if (!year || year < 2000 || year > 2100) {
      await tgSend('sendMessage', { chat_id, text: 'Invalid year — send again (e.g., 2024) or /cancel.' });
      return;
    }
    const td = { year };
    await setUserState(telegram_id, 'AWAITING_OLD_MONTH', td);
    await tgSend('sendMessage', { chat_id, text: 'Now send MONTH number (1-12).' });
    return;
  }

  if (state === 'AWAITING_OLD_MONTH') {
    const month = parseInt(text);
    if (!month || month < 1 || month > 12) {
      await tgSend('sendMessage', { chat_id, text: 'Invalid month — send 1-12 or /cancel.' });
      return;
    }
    const td = Object.assign({}, user.temp_data || {}, { month });
    await setUserState(telegram_id, 'AWAITING_OLD_DAY', td);
    await tgSend('sendMessage', { chat_id, text: 'Now send DAY number (1-31).' });
    return;
  }

  if (state === 'AWAITING_OLD_DAY') {
    const day = parseInt(text);
    const td = Object.assign({}, user.temp_data || {}, { day });
    // validate date
    try {
      const dt = new Date(td.year, td.month - 1, day);
      if (dt.getFullYear() !== td.year || dt.getMonth() !== td.month - 1 || dt.getDate() !== day) {
        throw new Error('invalid date');
      }
      const study_date = format(dt, 'yyyy-MM-dd');
      await setUserState(telegram_id, 'AWAITING_SUBMISSION', { study_date });
      await tgSend('sendMessage', { chat_id, text: `Date set to ${study_date}. Please send a photo with caption like "Maths 2.5" to submit.` });
    } catch (e) {
      await tgSend('sendMessage', { chat_id, text: 'Invalid date. Try again or /cancel.' });
    }
    return;
  }

  if (state === 'AWAITING_SUBMISSION') {
    // This state expects a PHOTO (handled in message.photo path) but user might send text.
    await tgSend('sendMessage', { chat_id, text: 'Please send a photo with a caption describing subject and hours (e.g., "Maths 2.5").' });
    return;
  }

  // Default: if HOME and text small, show main menu
  if (state === 'HOME') {
    await tgSend('sendMessage', Object.assign({ chat_id, text: 'Main Menu' }, makeMainMenuKeyboard()));
    return;
  }

  // fallback
  await tgSend('sendMessage', { chat_id, text: "I didn't understand that. Use the buttons or /start." });
}

async function handlePhotoMessage(message) {
  const chatId = message.chat.id;
  const telegram_id = message.from.id;
  const user = await ensureUser(telegram_id, (message.from.first_name || '') + (message.from.last_name ? ' ' + message.from.last_name : ''));
  const state = user.bot_state || 'HOME';

  // choose the best (largest) photo file_id
  const photos = message.photo || [];
  if (photos.length === 0) {
    await tgSend('sendMessage', { chat_id, text: 'No photo detected.' });
    return;
  }
  const best = photos[photos.length - 1];
  const file_id = best.file_id;
  const caption = message.caption || '';

  if (state !== 'AWAITING_SUBMISSION') {
    await tgSend('sendMessage', { chat_id, text: 'Not expecting a submission now. Use Today Submission or Old Date Submission from menu.' });
    return;
  }

  // figure out study_date from temp_data
  const td = user.temp_data || {};
  const study_date = td.study_date || format(new Date(), 'yyyy-MM-dd');

  // parse duration from caption
  const duration = parseDurationFromText(caption);
  const subject = caption ? caption.replace(/(\d+(?:\.\d+)?)/, '').trim() : '';
  if (!duration) {
    // ask to confirm hours if not parsed
    await tgSend('sendMessage', { chat_id, text: 'Could not detect hours in caption. Please reply with the number of hours (e.g., "2.5") or resend photo with caption including the hours.' });
    return;
  }

  // Show confirmation inline keyboard with Submit/Edit/Cancel
  const draft = { telegram_id, study_date, duration, subject, photo_file_id: file_id, caption };
  // Save draft temporarily in temp_data
  await setUserState(telegram_id, 'DRAFT_PENDING', { draft });

  const keyboard = {
    reply_markup: JSON.stringify({
      inline_keyboard: [
        [{ text: 'Submit', callback_data: 'CONFIRM_SUBMIT' }],
        [{ text: 'Edit Caption', callback_data: 'CONFIRM_EDIT' }],
        [{ text: 'Cancel', callback_data: 'CONFIRM_CANCEL' }]
      ]
    })
  };

  await tgSend('sendPhoto', { chat_id, photo: file_id, caption: `Found: ${subject || '-'} — ${duration} hours\nDate: ${study_date}\n\nPress Submit to save.` , ...keyboard});
}

async function handleConfirmAction(callbackQuery) {
  const { id, from, data, message } = callbackQuery;
  const telegram_id = from.id;
  const user = await ensureUser(telegram_id);
  const td = user.temp_data || {};
  const draft = td.draft;

  if (!draft) {
    await tgSend('answerCallbackQuery', { callback_query_id: id, text: 'No draft found or it expired.' });
    return;
  }

  if (data === 'CONFIRM_SUBMIT') {
    // insert into study_logs
    const { error } = await supabase.from('study_logs').insert([{
      telegram_id: draft.telegram_id,
      duration: draft.duration,
      subject: draft.subject,
      study_date: draft.study_date,
      photo_file_id: draft.photo_file_id,
      caption: draft.caption
    }]);
    if (error) {
      console.error('insert error', error);
      await tgSend('answerCallbackQuery', { callback_query_id: id, text: 'Error saving submission.' });
      return;
    }

    // forward photo to channel (use sendPhoto with file_id)
    if (CHANNEL_ID) {
      const captionFmt = `${user.real_name || user.username || 'Student'} studied ${draft.duration} hrs on ${draft.study_date} — ${draft.subject || ''}`;
      await tgSend('sendPhoto', { chat_id: CHANNEL_ID, photo: draft.photo_file_id, caption: captionFmt });
    }

    await setUserState(telegram_id, 'HOME', {});
    await tgSend('answerCallbackQuery', { callback_query_id: id, text: 'Submitted!' });
    await tgSend('sendMessage', Object.assign({ chat_id: message.chat.id, text: 'Your Data Has Been Submitted.' }, makeMainMenuKeyboard()));

  } else if (data === 'CONFIRM_EDIT') {
    // instruct user to send new caption text
    await setUserState(telegram_id, 'EDIT_DRAFT_CAPTION', { draft });
    await tgSend('answerCallbackQuery', { callback_query_id: id, text: 'Edit caption: send the new caption text now.' });
  } else if (data === 'CONFIRM_CANCEL') {
    await setUserState(telegram_id, 'HOME', {});
    await tgSend('answerCallbackQuery', { callback_query_id: id, text: 'Cancelled.' });
    await tgSend('sendMessage', Object.assign({ chat_id: message.chat.id, text: 'Cancelled.' }, makeMainMenuKeyboard()));
  } else {
    await tgSend('answerCallbackQuery', { callback_query_id: id, text: 'Unknown confirm action.' });
  }
}

export default async function handler(req, res) {
  // Vercel passes POST body JSON for Telegram Webhook
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

  const body = req.body;

  try {
    if (body.callback_query) {
      const cb = body.callback_query;
      // quick route for confirm actions
      if (['CONFIRM_SUBMIT','CONFIRM_EDIT','CONFIRM_CANCEL'].includes(cb.data)) {
        await handleConfirmAction(cb);
      } else {
        await handleCallbackQuery(cb);
      }
    } else if (body.message) {
      const message = body.message;
      if (message.photo) {
        await handlePhotoMessage(message);
      } else if (message.text) {
        // check if user in EDIT_DRAFT_CAPTION state
        const telegram_id = message.from.id;
        const { data: user } = await supabase.from('users').select('*').eq('telegram_id', telegram_id).maybeSingle();
        if (user && user.bot_state === 'EDIT_DRAFT_CAPTION') {
          const td = user.temp_data || {};
          const draft = td.draft || {};
          draft.caption = message.text;
          // update draft in temp_data and go back to DRAFT_PENDING with updated caption
          await setUserState(telegram_id, 'DRAFT_PENDING', { draft });
          await tgSend('sendMessage', { chat_id: message.chat.id, text: 'Caption updated. Press Submit to finish.', reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Submit', callback_data: 'CONFIRM_SUBMIT' }], [{ text: 'Cancel', callback_data: 'CONFIRM_CANCEL' }]] })});
        } else {
          await handleMessage(message);
        }
      } else {
        // unknown message type
        await tgSend('sendMessage', { chat_id: message.chat.id, text: 'Unsupported message type. Please send text or photo.' });
      }
    } else {
      // other webhook types ignored
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Handler error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
}
