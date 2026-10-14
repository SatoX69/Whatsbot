'use strict';

const moment = require('moment-timezone');

const TIME_ZONE = 'Asia/Dhaka';
const HOUR_MS = 60 * 60 * 1000;
const INTEREST_PER_HOUR = 0.003;
const TRANSFER_TAX_RATE = 0.08;
const WITHDRAWAL_INTEREST_TAX_RATE = 0.05;
const WITHDRAWAL_TAX_ROI_THRESHOLD = 0.10;
const STEAL_COOLDOWN_MS = 30 * 60 * 1000;
const WORK_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_MONEY = 9_000_000_000_000;
const MAX_HISTORY = 12;
const MAX_ALIASES = 16;
const ADMIN_COOLDOWN_BYPASS = true;

const MONEY_FORMATTER = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

let operationQueue = Promise.resolve();

function serializeOperation(callback) {
  const result = operationQueue.then(callback, callback);
  operationQueue = result.catch(() => undefined);
  return result;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numeric(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function roundMoney(value) {
  return Math.round((numeric(value) + Number.EPSILON) * 100) / 100;
}

function floorMoney(value) {
  return Math.floor((Math.max(0, numeric(value)) + 1e-9) * 100) / 100;
}

function roundPrecise(value) {
  return Math.round((numeric(value) + Number.EPSILON) * 1e8) / 1e8;
}

function money(value) {
  return MONEY_FORMATTER.format(floorMoney(value));
}

function safeAdd(left, right) {
  const result = roundMoney(numeric(left) + numeric(right));
  if (!Number.isFinite(result) || result < 0 || result > MAX_MONEY) {
    throw new Error('MONEY_LIMIT');
  }
  return result;
}

function canonicalId(value) {
  if (value === null || value === undefined) return '';
  let id = String(value).trim();
  if (!id) return '';
  if (id.startsWith('@') && !/^@(?:s\.whatsapp\.net|lid|g\.us)$/i.test(id)) {
    id = id.slice(1);
  }
  return id.replace(/:\d+(?=@)/, '');
}

function bareIdDigits(value) {
  const id = canonicalId(value);
  if (!id) return '';
  const head = id.includes('@') ? id.slice(0, id.indexOf('@')) : id;
  return head.replace(/\D/g, '');
}

function isBareDigits(value) {
  return /^\+?\d{5,30}$/.test(String(value || '').trim());
}

function addCandidate(list, value) {
  const id = canonicalId(value);
  if (!id) return;
  if (!list.includes(id)) list.push(id);
  if (id.includes('@')) {
    const digits = bareIdDigits(id);
    if (digits) {
      const deviceFree = id.replace(/:\d+(?=@)/, '');
      if (!list.includes(deviceFree)) list.push(deviceFree);
    }
  }
}

function participantList(event) {
  const participants = event && event.groupMetadata && event.groupMetadata.participants;
  return Array.isArray(participants) ? participants : [];
}

function sameIdentifier(left, right) {
  const a = canonicalId(left).toLowerCase();
  const b = canonicalId(right).toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes('@') || b.includes('@')) return false;
  return a.replace(/\D/g, '') === b.replace(/\D/g, '');
}

function participantMatches(participant, value) {
  if (!participant || !value) return false;
  const ids = [participant.id, participant.phoneNumber];
  return ids.some(id => sameIdentifier(id, value));
}

function appendParticipantAliases(list, event, seedValues) {
  const participants = participantList(event);
  for (const participant of participants) {
    if (seedValues.some(value => participantMatches(participant, value))) {
      addCandidate(list, participant.id);
      addCandidate(list, participant.phoneNumber);
    }
  }
}

function getSenderCandidates(event) {
  const result = [];
  const direct = [
    event && event.senderID,
    event && event.participantID,
    event && event.key && event.key.participant,
    event && event.raw && event.raw.key && event.raw.key.participant
  ].filter(Boolean);

  for (const id of direct) addCandidate(result, id);
  appendParticipantAliases(result, event, direct);
  return result;
}

function mentionIds(event) {
  const result = [];
  for (const value of Array.isArray(event && event.mentions) ? event.mentions : []) {
    addCandidate(result, value);
  }
  const rawMentions = event && event.contextInfo && event.contextInfo.mentionedJid;
  for (const value of Array.isArray(rawMentions) ? rawMentions : []) addCandidate(result, value);
  const rawContext = event && event.raw && event.raw.message && event.raw.message.extendedTextMessage && event.raw.message.extendedTextMessage.contextInfo;
  for (const value of Array.isArray(rawContext && rawContext.mentionedJid) ? rawContext.mentionedJid : []) {
    addCandidate(result, value);
  }
  return [...new Set(result)];
}

function isAmountToken(value) {
  const text = String(value || '').trim().toLowerCase();
  return text === 'all' || text === 'max' || /^\$?[\d,]+(?:\.\d{1,2})?[kmb]?$/.test(text);
}

function parseAmount(value, allowAll = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error('AMOUNT_REQUIRED');
  }

  const original = String(value).trim().toLowerCase();
  if (allowAll && (original === 'all' || original === 'max')) return 'all';

  const normalized = original.replace(/^\$/, '').replace(/,/g, '').replace(/\s+/g, '');
  const match = normalized.match(/^(\d+(?:\.\d{1,2})?)([kmb])?$/i);
  if (!match) throw new Error('INVALID_AMOUNT');

  const multipliers = { k: 1e3, m: 1e6, b: 1e9 };
  const amount = roundMoney(Number(match[1]) * (multipliers[match[2]] || 1));
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('INVALID_AMOUNT');
  if (amount > MAX_MONEY) throw new Error('MONEY_LIMIT');
  return amount;
}

function parseTargetArguments(args, event) {
  const tokens = Array.isArray(args) ? args.map(value => String(value ?? '').trim()).filter(Boolean) : [];
  let target = tokens[1] || '';
  let amountToken = tokens[2] || '';
  const mentions = mentionIds(event);

  const targetMatchesMention = target && mentions.some(id => bareIdDigits(id) && bareIdDigits(id) === bareIdDigits(target));
  if (target && isAmountToken(target) && mentions.length && !targetMatchesMention) {
    amountToken = target;
    target = mentions[0];
  } else if (!target && mentions.length) {
    target = mentions[0];
  } else if (target.startsWith('@') && !/@(?:s\.whatsapp\.net|lid)$/i.test(target)) {
    const wantedDigits = bareIdDigits(target);
    const matched = mentions.find(id => wantedDigits && bareIdDigits(id) === wantedDigits);
    target = matched || mentions[0] || target.slice(1);
  }

  return { target, amountToken };
}

function participantAliasesForTarget(rawTarget, event) {
  const result = [];
  const seed = canonicalId(rawTarget);
  const digits = bareIdDigits(seed);
  const participants = participantList(event);

  for (const participant of participants) {
    const ids = [participant.id, participant.phoneNumber].filter(Boolean);
    const matched = ids.some(id => {
      if (sameIdentifier(id, seed)) return true;
      return Boolean(digits && bareIdDigits(id) === digits && !String(seed).includes('@'));
    });
    if (!matched) continue;

    const matchedId = ids.find(id => sameIdentifier(id, seed) || (isBareDigits(seed) && bareIdDigits(id) === seed.replace(/\D/g, '')));
    if (matchedId) addCandidate(result, matchedId);
    addCandidate(result, participant.id);
    addCandidate(result, participant.phoneNumber);
  }

  const mentions = mentionIds(event);
  const mention = mentions.find(id => sameIdentifier(id, seed) || (digits && bareIdDigits(id) === digits));
  if (mention) {
    const prior = [...result];
    result.length = 0;
    addCandidate(result, mention);
    for (const id of prior) addCandidate(result, id);
    appendParticipantAliases(result, event, [mention]);
  }

  return result;
}

async function readAllUsers(usersData) {
  const result = await usersData.getAll();
  if (Array.isArray(result)) return result;
  if (isObject(result)) return Object.values(result);
  return [];
}

function getRecordId(record) {
  return record && (record.userID || record.id || record.uid) || '';
}

function getRecordAliases(record) {
  const bank = record && record.data && record.data.bank;
  const aliases = Array.isArray(bank && bank.aliases) ? bank.aliases : [];
  return aliases.map(canonicalId).filter(Boolean);
}

function recordMatchesCandidates(record, candidates, rawTarget) {
  const recordId = canonicalId(getRecordId(record));
  const candidateSet = new Set(candidates.map(value => canonicalId(value).toLowerCase()));
  if (recordId && candidateSet.has(recordId.toLowerCase())) return true;

  const aliases = getRecordAliases(record);
  if (aliases.some(alias => candidateSet.has(alias.toLowerCase()))) return true;

  if (isBareDigits(rawTarget)) {
    const digits = String(rawTarget).replace(/\D/g, '');
    const knownDigits = [getRecordId(record), record && record.phone, ...aliases].filter(Boolean);
    return knownDigits.some(value => bareIdDigits(value) === digits);
  }

  return false;
}

async function findExistingId(usersData, candidates, rawTarget = '') {
  const ordered = [...new Set(candidates.map(canonicalId).filter(Boolean))];
  for (const candidate of ordered) {
    try {
      if (usersData.existsSync(candidate)) return { id: candidate, ambiguous: false };
    } catch (_) {
      // Fall through to the record scan for DataStore-compatible implementations.
    }
  }

  const records = await readAllUsers(usersData);
  const candidateSet = new Set(ordered.map(value => value.toLowerCase()));
  const direct = records.filter(record => candidateSet.has(canonicalId(getRecordId(record)).toLowerCase()));
  if (direct.length === 1) return { id: getRecordId(direct[0]), ambiguous: false };
  if (direct.length > 1) return { id: '', ambiguous: true };

  const matches = records.filter(record => recordMatchesCandidates(record, ordered, rawTarget));
  const ids = [...new Set(matches.map(getRecordId).map(String).filter(Boolean))];
  if (ids.length === 1) return { id: ids[0], ambiguous: false };
  if (ids.length > 1) return { id: '', ambiguous: true };
  return { id: '', ambiguous: false };
}

async function resolveSenderId(usersData, event) {
  const candidates = getSenderCandidates(event);
  const found = await findExistingId(usersData, candidates);
  if (found.ambiguous) throw new Error('IDENTITY_AMBIGUOUS');
  const preferred = canonicalId(event && event.senderID) || canonicalId(event && event.participantID) || candidates[0];
  if (!preferred) throw new Error('IDENTITY_MISSING');
  return { id: found.id || preferred, aliases: candidates };
}

async function resolveTargetId(usersData, rawTarget, event) {
  const original = String(rawTarget || '').trim();
  if (!original) throw new Error('TARGET_REQUIRED');

  let target = canonicalId(original);
  if (target.startsWith('@') && !/@(?:s\.whatsapp\.net|lid|g\.us)$/i.test(target)) target = target.slice(1);
  const candidates = participantAliasesForTarget(target, event);
  if (isBareDigits(target)) {
    const digits = target.replace(/\D/g, '');
    addCandidate(candidates, digits);
    addCandidate(candidates, `${digits}@s.whatsapp.net`);
    addCandidate(candidates, `${digits}@lid`);
  } else {
    addCandidate(candidates, target);
    const digits = bareIdDigits(target);
    if (digits && !target.includes('@')) {
      addCandidate(candidates, `${digits}@s.whatsapp.net`);
      addCandidate(candidates, `${digits}@lid`);
    }
  }

  const found = await findExistingId(usersData, candidates, target);
  if (found.ambiguous) throw new Error('TARGET_AMBIGUOUS');
  if (found.id) return { id: found.id, aliases: candidates };

  if (isBareDigits(target)) {
    const digits = target.replace(/\D/g, '');
    const participantCandidate = candidates.find(id => /@(?:lid|s\.whatsapp\.net)$/i.test(id));
    return { id: participantCandidate || `${digits}@s.whatsapp.net`, aliases: candidates };
  }

  if (!target.includes('@')) throw new Error('TARGET_INVALID');
  if (!/@(?:s\.whatsapp\.net|lid)$/i.test(target)) throw new Error('TARGET_INVALID');
  return { id: target, aliases: candidates };
}

function participantName(event, id) {
  const participants = participantList(event);
  const participant = participants.find(item => participantMatches(item, id));
  return participant && (participant.username || participant.name || participant.pushName) || '';
}

function defaultAccount(now) {
  return {
    version: 1,
    principal: 0,
    interest: 0,
    lots: [],
    lastAccruedAt: now,
    createdAt: now,
    daily: { lastDate: '', streak: 0 },
    workAt: 0,
    stealAt: 0,
    history: [],
    aliases: [],
    stats: {
      deposited: 0,
      withdrawn: 0,
      sent: 0,
      received: 0,
      stolen: 0,
      robbed: 0,
      failedSteals: 0,
      dailyEarned: 0,
      workEarned: 0
    }
  };
}

function normalizeAccount(raw, now) {
  const base = defaultAccount(now);
  if (!isObject(raw)) return base;

  base.version = 1;
  const legacyPrincipal = Math.max(0, Math.min(MAX_MONEY, floorMoney(raw.principal)));
  base.interest = Math.max(0, Math.min(MAX_MONEY, roundPrecise(raw.interest)));
  base.lastAccruedAt = numeric(raw.lastAccruedAt, now);
  if (!Number.isFinite(base.lastAccruedAt) || base.lastAccruedAt <= 0 || base.lastAccruedAt > now) {
    base.lastAccruedAt = now;
  }
  base.createdAt = numeric(raw.createdAt, now);
  if (!Number.isFinite(base.createdAt) || base.createdAt <= 0 || base.createdAt > now) base.createdAt = now;

  const lots = [];
  if (Array.isArray(raw.lots)) {
    for (const item of raw.lots) {
      if (!isObject(item)) continue;
      const amount = floorMoney(item.amount);
      if (amount <= 0) continue;
      let lastAccruedAt = numeric(item.lastAccruedAt, base.lastAccruedAt);
      if (!Number.isFinite(lastAccruedAt) || lastAccruedAt <= 0 || lastAccruedAt > now) lastAccruedAt = now;
      const sameTick = lots.find(lot => lot.lastAccruedAt === lastAccruedAt);
      if (sameTick) sameTick.amount = roundMoney(sameTick.amount + amount);
      else lots.push({ amount, lastAccruedAt });
    }
  }
  if (!lots.length && legacyPrincipal > 0) {
    lots.push({ amount: legacyPrincipal, lastAccruedAt: base.lastAccruedAt });
  }
  base.lots = lots;
  base.principal = floorMoney(lots.reduce((sum, lot) => sum + lot.amount, 0));
  base.lastAccruedAt = lots.length
    ? Math.min(...lots.map(lot => lot.lastAccruedAt))
    : now;

  base.daily = {
    lastDate: typeof (raw.daily && raw.daily.lastDate) === 'string' ? raw.daily.lastDate : '',
    streak: Math.max(0, Math.floor(numeric(raw.daily && raw.daily.streak, 0)))
  };
  base.workAt = Math.max(0, numeric(raw.workAt, 0));
  base.stealAt = Math.max(0, numeric(raw.stealAt, 0));
  base.history = Array.isArray(raw.history)
    ? raw.history.filter(item => isObject(item) && Number.isFinite(Number(item.at))).slice(0, MAX_HISTORY)
    : [];
  base.aliases = Array.isArray(raw.aliases)
    ? [...new Set(raw.aliases.map(canonicalId).filter(Boolean))].slice(0, MAX_ALIASES)
    : [];

  const oldStats = isObject(raw.stats) ? raw.stats : {};
  for (const key of Object.keys(base.stats)) {
    base.stats[key] = Math.max(0, Math.min(MAX_MONEY, numeric(oldStats[key], 0)));
  }
  return base;
}

function accrueInterest(account, now) {
  if (!Array.isArray(account.lots) || account.lots.length === 0) {
    account.principal = 0;
    account.lastAccruedAt = now;
    return 0;
  }

  let totalHours = 0;
  for (const lot of account.lots) {
    if (!Number.isFinite(lot.lastAccruedAt) || lot.lastAccruedAt <= 0 || lot.lastAccruedAt > now) {
      lot.lastAccruedAt = now;
    }
    const elapsed = now - lot.lastAccruedAt;
    const completedHours = Math.floor(elapsed / HOUR_MS);
    if (completedHours <= 0) continue;

    const accrued = lot.amount * INTEREST_PER_HOUR * completedHours;
    if (!Number.isFinite(accrued) || accrued < 0 || account.interest + accrued > MAX_MONEY) {
      throw new Error('MONEY_LIMIT');
    }
    account.interest = roundPrecise(account.interest + accrued);
    lot.lastAccruedAt += completedHours * HOUR_MS;
    totalHours += completedHours;
  }

  account.lots = account.lots.filter(lot => lot.amount > 0);
  account.principal = floorMoney(account.lots.reduce((sum, lot) => sum + lot.amount, 0));
  account.lastAccruedAt = account.lots.length
    ? Math.min(...account.lots.map(lot => lot.lastAccruedAt))
    : now;
  return totalHours;
}

function removePrincipalLots(account, amount, now) {
  let remaining = roundMoney(amount);
  for (const lot of account.lots) {
    if (remaining <= 0) break;
    const removed = Math.min(lot.amount, remaining);
    lot.amount = roundMoney(lot.amount - removed);
    remaining = roundMoney(remaining - removed);
  }
  if (remaining > 0.009) throw new Error('MONEY_LIMIT');
  account.lots = account.lots.filter(lot => lot.amount > 0);
  account.principal = floorMoney(account.lots.reduce((sum, lot) => sum + lot.amount, 0));
  account.lastAccruedAt = account.lots.length
    ? Math.min(...account.lots.map(lot => lot.lastAccruedAt))
    : now;
}

function mergeAliases(account, aliases) {
  const combined = [...account.aliases];
  for (const alias of aliases || []) {
    const id = canonicalId(alias);
    if (id && !combined.includes(id)) combined.push(id);
  }
  account.aliases = combined.slice(-MAX_ALIASES);
}

function walletFromRecord(user) {
  const value = user && user.money !== undefined && user.money !== null ? Number(user.money) : 0;
  if (!Number.isFinite(value) || value < 0 || value > MAX_MONEY) throw new Error('WALLET_INVALID');
  return floorMoney(value);
}

async function loadBankUser(usersData, id, aliases, event, now) {
  const metaName = participantName(event, id);
  const displayName = metaName || (event && (event.pushName || event.verifiedName)) || 'Unknown user';

  try {
    await usersData.ensure(id, { name: displayName, pushName: displayName, money: 0 });
  } catch (error) {
    if (!error || (error.name !== 'DATA_ALREADY_EXISTS' && !usersData.existsSync(id))) throw error;
  }

  const user = await usersData.get(id);
  const storedBank = await usersData.get(id, 'data.bank', null);
  const account = normalizeAccount(storedBank, now);
  mergeAliases(account, [id, ...(aliases || [])]);
  accrueInterest(account, now);
  const wallet = walletFromRecord(user);
  const dirty = !isObject(storedBank) || JSON.stringify(account) !== JSON.stringify(storedBank);

  return {
    id,
    user,
    account,
    wallet,
    walletRaw: user && user.money !== undefined && user.money !== null ? user.money : 0,
    storedBank: isObject(storedBank) ? storedBank : null,
    dirty
  };
}

function makeChange(loaded, wallet, account) {
  const change = {
    id: loaded.id,
    expectedWalletRaw: loaded.walletRaw,
    expectedBankRaw: loaded.storedBank,
    account: account || loaded.account
  };
  if (wallet !== undefined) change.wallet = roundMoney(wallet);
  return change;
}

function sameStoredValue(left, right) {
  return JSON.stringify(left === undefined ? null : left) === JSON.stringify(right === undefined ? null : right);
}

async function commitChanges(usersData, changes) {
  const unique = new Set();
  const snapshots = [];

  for (const change of changes) {
    if (unique.has(change.id)) throw new Error('DUPLICATE_ACCOUNT_CHANGE');
    unique.add(change.id);

    const user = await usersData.get(change.id);
    const bank = await usersData.get(change.id, 'data.bank', null);
    const walletRaw = user && user.money !== undefined && user.money !== null ? user.money : 0;
    if (Number(walletRaw) !== Number(change.expectedWalletRaw ?? 0) || !sameStoredValue(isObject(bank) ? bank : null, change.expectedBankRaw)) {
      throw new Error('CONCURRENT_UPDATE');
    }

    snapshots.push({
      id: change.id,
      walletRaw,
      bankRaw: isObject(bank) ? bank : null,
      hasBank: isObject(bank)
    });
  }

  const applied = [];
  try {
    for (let index = 0; index < changes.length; index++) {
      const change = changes[index];
      applied.push(snapshots[index]);
      if (change.wallet !== undefined) await usersData.set(change.id, roundMoney(change.wallet), 'money');
      await usersData.set(change.id, change.account, 'data.bank');
    }
  } catch (error) {
    for (const snapshot of applied.reverse()) {
      try {
        await usersData.set(snapshot.id, snapshot.walletRaw, 'money');
        if (snapshot.hasBank) await usersData.set(snapshot.id, snapshot.bankRaw, 'data.bank');
        else await usersData.deleteKey(snapshot.id, 'data.bank');
      } catch (_) {
        // The original failure is more useful; the caller is told to verify balances.
      }
    }
    throw error;
  }
}

function pushHistory(account, type, amount, detail, now) {
  account.history.unshift({
    type,
    amount: roundPrecise(numeric(amount, 0)),
    detail: String(detail || '').slice(0, 180),
    at: now
  });
  account.history = account.history.slice(0, MAX_HISTORY);
}

function isPrivileged(event) {
  return Boolean(ADMIN_COOLDOWN_BYPASS && event && (event.isBotDev === true || event.isBotAdmin === true));
}

function durationText(milliseconds) {
  let seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function timeAt(timestamp) {
  return moment.tz(timestamp, TIME_ZONE).format('MMM D, YYYY [at] h:mm A');
}

function accountBalance(account) {
  return floorMoney(account.principal + account.interest);
}

function nextInterestLine(account, now) {
  if (account.principal <= 0 || !Array.isArray(account.lots) || !account.lots.length) {
    return 'Interest timer: deposit coins to wake it up.';
  }
  const nextAt = Math.min(...account.lots.map(lot => lot.lastAccruedAt + HOUR_MS));
  const remaining = Math.max(0, nextAt - now);
  return `Next interest tick: ${timeAt(nextAt)} Dhaka time (in ${durationText(remaining)}).`;
}

async function getStoredName(usersData, id, fallback) {
  try {
    if (typeof usersData.getName === 'function') {
      const name = await usersData.getName(id);
      if (typeof name === 'string' && name.trim()) return name.trim();
    }
    const user = await usersData.get(id);
    for (const value of [user && user.name, user && user.username, user && user.pushName, user && user.verifiedName]) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch (_) {
    // The ID is still enough to identify an account in the receipt.
  }
  return fallback || 'Unknown user';
}

function userLabel(name, id) {
  return `${name} (${canonicalId(id) || id})`;
}

function accountSummary(loaded, now) {
  const account = loaded.account;
  const principal = floorMoney(account.principal);
  const interest = floorMoney(account.interest);
  const bankTotal = accountBalance(account);
  const netWorth = floorMoney(loaded.wallet + account.principal + account.interest);
  const lines = [
    `🏦 *THE BANK OF QUESTIONABLE DECISIONS*`,
    `Wallet: ${money(loaded.wallet)} coins`,
    `Deposited principal: ${money(principal)} coins`,
    `Interest earned: ${money(interest)} coins`,
    `Vault total: ${money(bankTotal)} coins`,
    `Net worth: ${money(netWorth)} coins`,
    nextInterestLine(account, now),
    `Interest: 0.30% per completed hour on principal; no compounding.`,
    `Transfer tax: 8%. Withdrawal tax: 5% of withdrawn interest after gains reach 10% of principal.`,
    `Try: deposit 1k · withdraw all · send @user 200 · daily · work · steal @user · help`
  ];
  if (loaded.wallet < 100 && bankTotal < 100) lines.splice(1, 0, 'Status: financially haunted.');
  return lines.join('\n');
}

function helpText() {
  return [
    `🏦 *BANK COMMANDS*`,
    `• [0m/bank — show wallet, principal, interest and net worth`,
    `• /bank deposit <amount|all> — move wallet coins into the vault`,
    `• /bank withdraw <amount|all> — withdraw from the vault`,
    `• /bank send <@mention|UID> <amount|all> — transfer with 8% tax`,
    `• /bank steal <@mention|UID> [amount] — attempt a wallet robbery`,
    `• /bank daily — claim one Dhaka-day reward`,
    `• /bank work — earn coins (60-minute cooldown)`,
    `• /bank interest — inspect the savings rules`,
    `• /bank history — show your latest transactions`,
    `• /bank top — rank the richest accounts`,
    `• /bank help — show this message`,
    `Amounts support commas and k/m/b suffixes: 1,500 · 2.5k · 1m.`,
    `Unknown subcommands show your account summary. The bank is dramatic, not psychic.`
  ].join('\n');
}

function interestText(loaded, now) {
  const account = loaded.account;
  const roi = account.principal > 0 ? account.interest / account.principal : 0;
  return [
    `📈 *SAVINGS RULES*`,
    `Principal: ${money(account.principal)} coins`,
    `Accrued interest: ${money(account.interest)} coins`,
    `Rate: 0.30% per completed hour, calculated against principal only.`,
    `Interest does not compound; new deposits start earning from their deposit time.`,
    `Current return: ${(roi * 100).toFixed(2)}% of principal.`,
    `Withdrawal tax activates at 10.00% return and takes 5% of the interest portion you withdraw.`,
    nextInterestLine(account, now)
  ].join('\n');
}

function readAmountArgument(args, index = 1, allowAll = true) {
  return parseAmount(Array.isArray(args) ? args[index] : undefined, allowAll);
}

async function doDeposit({ args, message, usersData, loaded, now }) {
  const parsed = readAmountArgument(args, 1, true);
  const amount = parsed === 'all' ? loaded.wallet : parsed;
  if (amount <= 0) return message.reply('Your wallet is too empty to deposit anything. Go find a side quest.');
  if (amount > loaded.wallet) return message.reply(`Deposit declined. You have ${money(loaded.wallet)} coins in your wallet, not ${money(amount)}.`);

  const account = loaded.account;
  const sameTick = account.lots.find(lot => lot.lastAccruedAt === now);
  if (sameTick) sameTick.amount = roundMoney(sameTick.amount + amount);
  else account.lots.push({ amount, lastAccruedAt: now });
  account.principal = floorMoney(account.lots.reduce((sum, lot) => sum + lot.amount, 0));
  if (account.principal > MAX_MONEY) throw new Error('MONEY_LIMIT');
  account.lastAccruedAt = account.lots.length ? Math.min(...account.lots.map(lot => lot.lastAccruedAt)) : now;
  account.stats.deposited = safeAdd(account.stats.deposited, amount);
  pushHistory(account, 'deposit', amount, 'Wallet → vault', now);

  await commitChanges(usersData, [makeChange(loaded, loaded.wallet - amount, account)]);
  return message.reply([
    `Deposit complete. The vault has accepted your coins and is pretending to be responsible.`,
    `Deposited: ${money(amount)} coins`,
    `Wallet left: ${money(loaded.wallet - amount)} coins`,
    `Vault principal: ${money(account.principal)} coins`,
    `Interest starts counting from this deposit; no deposit fee.`,
    nextInterestLine(account, now)
  ].join('\n'));
}

async function doWithdraw({ args, message, usersData, loaded, now }) {
  const parsed = readAmountArgument(args, 1, true);
  const available = accountBalance(loaded.account);
  const amount = parsed === 'all' ? available : parsed;
  if (amount <= 0) return message.reply('The vault is empty. Even the dust has left.');
  if (amount > available) return message.reply(`Withdrawal declined. The vault has ${money(available)} available, not ${money(amount)}.`);

  const account = loaded.account;
  const gains = floorMoney(account.interest);
  const eligibleForTax = account.principal > 0 && account.interest >= account.principal * WITHDRAWAL_TAX_ROI_THRESHOLD;
  const interestPortion = floorMoney(Math.min(amount, gains));
  const principalPortion = roundMoney(amount - interestPortion);
  const tax = eligibleForTax ? roundMoney(interestPortion * WITHDRAWAL_INTEREST_TAX_RATE) : 0;
  const received = roundMoney(amount - tax);

  account.interest = Math.max(0, roundPrecise(account.interest - interestPortion));
  removePrincipalLots(account, principalPortion, now);
  account.stats.withdrawn = safeAdd(account.stats.withdrawn, amount);
  pushHistory(account, 'withdraw', amount, `Gross ${money(amount)}; tax ${money(tax)}`, now);

  const newWallet = safeAdd(loaded.wallet, received);
  await commitChanges(usersData, [makeChange(loaded, newWallet, account)]);

  return message.reply([
    `Withdrawal processed. The vault has released the funds after its tiny bureaucratic tantrum.`,
    `Gross withdrawal: ${money(amount)} coins`,
    `Tax: ${money(tax)} coins${eligibleForTax ? ' (5% of the interest portion)' : ' (not applicable yet)'}`,
    `Added to wallet: ${money(received)} coins`,
    `Interest used: ${money(interestPortion)} · Principal used: ${money(principalPortion)}`,
    `Wallet now: ${money(newWallet)} coins`,
    `Vault remaining: ${money(accountBalance(account))} coins`
  ].join('\n'));
}

async function doSend({ args, event, message, usersData, loaded, now }) {
  const { target, amountToken } = parseTargetArguments(args, event);
  if (!target) throw new Error('TARGET_REQUIRED');
  if (!amountToken) throw new Error('AMOUNT_REQUIRED');

  const targetResolved = await resolveTargetId(usersData, target, event);
  if (targetResolved.id === loaded.id) return message.reply('Sending money to yourself is a very expensive way to move it between pockets.');

  const parsed = parseAmount(amountToken, true);
  const amount = parsed === 'all' ? loaded.wallet : parsed;
  if (amount <= 0) return message.reply('Your wallet has nothing worth transferring.');
  if (amount > loaded.wallet) return message.reply(`Transfer declined. Wallet balance: ${money(loaded.wallet)} coins.`);

  const targetNameHint = participantName(event, targetResolved.id) || (isBareDigits(target) ? `User ${String(target).replace(/\D/g, '')}` : 'Account holder');
  const recipient = await loadBankUser(usersData, targetResolved.id, targetResolved.aliases, event, now);
  if (recipient.id === loaded.id) return message.reply('Those identifiers resolve to your own account. Transfer cancelled.');

  const tax = roundMoney(amount * TRANSFER_TAX_RATE);
  const received = roundMoney(amount - tax);
  const senderWallet = roundMoney(loaded.wallet - amount);
  const recipientWallet = safeAdd(recipient.wallet, received);

  loaded.account.stats.sent = safeAdd(loaded.account.stats.sent, amount);
  recipient.account.stats.received = safeAdd(recipient.account.stats.received, received);
  pushHistory(loaded.account, 'send', amount, `To ${recipient.id}; tax ${money(tax)}`, now);
  pushHistory(recipient.account, 'receive', received, `From ${loaded.id}`, now);

  await commitChanges(usersData, [
    makeChange(loaded, senderWallet, loaded.account),
    makeChange(recipient, recipientWallet, recipient.account)
  ]);

  const recipientName = await getStoredName(usersData, recipient.id, targetNameHint);
  return message.reply([
    `Transfer successful. The tax goblin has collected its 8%.`,
    `Sent to: ${recipientName}`,
    `Recipient ID: ${canonicalId(recipient.id)}`,
    `Amount debited: ${money(amount)} coins`,
    `Transfer tax (8%): ${money(tax)} coins`,
    `Recipient receives: ${money(received)} coins`,
    `Your wallet: ${money(senderWallet)} coins`
  ].join('\n'));
}

async function doSteal({ args, event, message, usersData, loaded, now }) {
  const { target, amountToken } = parseTargetArguments(args, event);
  if (!target) throw new Error('TARGET_REQUIRED');
  const targetResolved = await resolveTargetId(usersData, target, event);
  if (targetResolved.id === loaded.id) return message.reply('You cannot rob yourself. That is called budgeting.');

  const recipientHint = participantName(event, targetResolved.id) || (isBareDigits(target) ? `User ${String(target).replace(/\D/g, '')}` : 'Account holder');
  const victim = await loadBankUser(usersData, targetResolved.id, targetResolved.aliases, event, now);
  if (victim.id === loaded.id) return message.reply('Those identifiers resolve to your own account. Robbery cancelled.');
  if (victim.wallet <= 0) return message.reply(`${recipientHint} has no wallet cash. The robbery has been cancelled due to severe lack of loot.`);

  const privileged = isPrivileged(event);
  const remaining = loaded.account.stealAt + STEAL_COOLDOWN_MS - now;
  if (remaining > 0 && !privileged) {
    return message.reply(`The underworld remembers your face. Try stealing again in ${durationText(remaining)}.`);
  }

  let amount;
  if (amountToken) {
    const parsed = parseAmount(amountToken, true);
    amount = parsed === 'all' ? victim.wallet : parsed;
  } else {
    const fraction = 0.08 + Math.random() * 0.17;
    amount = floorMoney(Math.min(victim.wallet, Math.max(1, victim.wallet * fraction)));
  }
  if (amount <= 0) return message.reply('There is nothing to steal. The economy has defeated you.');
  if (amount > victim.wallet) return message.reply(`That target only has ${money(victim.wallet)} coins in their wallet. Pick a smaller amount.`);

  const succeeded = Math.random() < 0.58;
  if (!privileged) loaded.account.stealAt = now;

  if (succeeded) {
    const thiefWallet = safeAdd(loaded.wallet, amount);
    const victimWallet = roundMoney(victim.wallet - amount);
    loaded.account.stats.stolen = safeAdd(loaded.account.stats.stolen, amount);
    victim.account.stats.robbed = safeAdd(victim.account.stats.robbed, amount);
    pushHistory(loaded.account, 'steal', amount, `Stolen from ${victim.id}`, now);
    pushHistory(victim.account, 'robbed', amount, `Taken by ${loaded.id}`, now);
    await commitChanges(usersData, [
      makeChange(loaded, thiefWallet, loaded.account),
      makeChange(victim, victimWallet, victim.account)
    ]);
    const victimName = await getStoredName(usersData, victim.id, recipientHint);
    return message.reply([
      `🦹 Robbery successful. The ethics committee has been notified and immediately went on lunch break.`,
      `Victim: ${victimName}`,
      `Victim ID: ${canonicalId(victim.id)}`,
      `Loot: ${money(amount)} coins`,
      `Your wallet: ${money(thiefWallet)} coins`,
      `Their wallet: ${money(victimWallet)} coins`,
      privileged ? 'Cooldown bypass: bot staff privileges.' : `Heat level: high. Cooldown: ${durationText(STEAL_COOLDOWN_MS)}.`
    ].join('\n'));
  }

  const fine = floorMoney(Math.min(loaded.wallet, Math.max(1, amount * 0.15)));
  const thiefWallet = roundMoney(loaded.wallet - fine);
  const victimWallet = safeAdd(victim.wallet, fine);
  loaded.account.stats.failedSteals = safeAdd(loaded.account.stats.failedSteals, 1);
  pushHistory(loaded.account, 'failed_steal', fine, `Caught while targeting ${victim.id}`, now);
  if (fine > 0) pushHistory(victim.account, 'robbery_restitution', fine, `Recovered from ${loaded.id}`, now);

  await commitChanges(usersData, [
    makeChange(loaded, thiefWallet, loaded.account),
    makeChange(victim, victimWallet, victim.account)
  ]);
  const victimName = await getStoredName(usersData, victim.id, recipientHint);
  return message.reply([
    `🚨 ROBBERY FAILED. You tripped over your own criminal mastermind plans.`,
    `Target: ${victimName}`,
    `Target ID: ${canonicalId(victim.id)}`,
    `Attempted loot: ${money(amount)} coins`,
    `Fine paid to target: ${money(fine)} coins`,
    `Your wallet: ${money(thiefWallet)} coins`,
    privileged ? 'Cooldown bypass: bot staff privileges.' : `Come back in ${durationText(STEAL_COOLDOWN_MS)} if your dignity recovers.`
  ].join('\n'));
}

async function doDaily({ message, usersData, loaded, event, now }) {
  const today = moment.tz(now, TIME_ZONE).format('YYYY-MM-DD');
  if (loaded.account.daily.lastDate === today) {
    const nextDay = moment.tz(now, TIME_ZONE).add(1, 'day').startOf('day').valueOf();
    return message.reply(`Daily coins already claimed for ${today}. Your next reset is ${timeAt(nextDay)} Dhaka time.`);
  }

  const yesterday = moment.tz(now, TIME_ZONE).subtract(1, 'day').format('YYYY-MM-DD');
  const streak = loaded.account.daily.lastDate === yesterday ? loaded.account.daily.streak + 1 : 1;
  const reward = 500 + Math.min(Math.max(streak - 1, 0), 7) * 75 + Math.floor(150 + Math.random() * 301);
  const wallet = safeAdd(loaded.wallet, reward);
  loaded.account.daily = { lastDate: today, streak };
  loaded.account.stats.dailyEarned = safeAdd(loaded.account.stats.dailyEarned, reward);
  pushHistory(loaded.account, 'daily', reward, `Daily streak ${streak}`, now);
  await commitChanges(usersData, [makeChange(loaded, wallet, loaded.account)]);

  return message.reply([
    `🎁 Daily reward claimed for ${today} (${TIME_ZONE}).`,
    `Reward: ${money(reward)} coins`,
    `Streak: ${streak} day${streak === 1 ? '' : 's'}`,
    `Wallet: ${money(wallet)} coins`,
    event && event.isBotDev ? 'The central bank suspects you have administrative plot armor.' : 'Spend responsibly. Or dramatically.'
  ].join('\n'));
}

async function doWork({ message, usersData, loaded, event, now }) {
  const privileged = isPrivileged(event);
  const remaining = loaded.account.workAt + WORK_COOLDOWN_MS - now;
  if (remaining > 0 && !privileged) {
    return message.reply(`Your shift manager says you are still on break for ${durationText(remaining)}.`);
  }

  const reward = 250 + Math.floor(Math.random() * 601);
  const wallet = safeAdd(loaded.wallet, reward);
  if (!privileged) loaded.account.workAt = now;
  loaded.account.stats.workEarned = safeAdd(loaded.account.stats.workEarned, reward);
  pushHistory(loaded.account, 'work', reward, 'Honest-ish employment', now);
  await commitChanges(usersData, [makeChange(loaded, wallet, loaded.account)]);

  const jobs = [
    'You reorganized a dragon’s tax receipts.',
    'You reviewed 47 terms-of-service pop-ups and survived.',
    'You taught a vending machine the concept of capitalism.',
    'You debugged a spreadsheet that was emotionally unavailable.',
    'You convinced a printer to print on the first try.'
  ];
  return message.reply([
    `🧰 Shift completed: ${jobs[Math.floor(Math.random() * jobs.length)]}`,
    `Pay: ${money(reward)} coins`,
    `Wallet: ${money(wallet)} coins`,
    privileged ? 'Staff perk: cooldown bypass enabled.' : `Next shift in ${durationText(WORK_COOLDOWN_MS)}.`
  ].join('\n'));
}

async function doHistory({ message, loaded }) {
  const history = loaded.account.history;
  if (!history.length) return message.reply('No transactions yet. The ledger is pristine, suspiciously so.');

  const labels = {
    deposit: 'DEPOSIT',
    withdraw: 'WITHDRAW',
    send: 'SENT',
    receive: 'RECEIVED',
    steal: 'STOLE',
    robbed: 'ROBBED',
    failed_steal: 'FAILED ROBBERY',
    robbery_restitution: 'RESTITUTION',
    daily: 'DAILY',
    work: 'WORK'
  };
  const lines = history.slice(0, 8).map(entry => {
    const label = labels[entry.type] || String(entry.type || 'EVENT').toUpperCase();
    const stamp = timeAt(Number(entry.at));
    return `• ${stamp} — ${label} ${money(entry.amount)}${entry.detail ? ` (${entry.detail})` : ''}`;
  });
  return message.reply(`📒 *RECENT BANK ACTIVITY*\n${lines.join('\n')}`);
}

async function doLeaderboard({ message, usersData, now }) {
  const users = await readAllUsers(usersData);
  const ranked = [];
  for (const user of users) {
    const id = getRecordId(user);
    if (!id) continue;
    const wallet = Math.max(0, floorMoney(user.money));
    const account = normalizeAccount(user.data && user.data.bank, now);
    accrueInterest(account, now);
    const netWorth = floorMoney(wallet + account.principal + account.interest);
    if (netWorth <= 0) continue;
    const name = [user.name, user.username, user.pushName].find(value => typeof value === 'string' && value.trim()) || canonicalId(id);
    ranked.push({ id, name, netWorth });
  }

  ranked.sort((a, b) => b.netWorth - a.netWorth);
  const top = ranked.slice(0, 10);
  if (!top.length) return message.reply('The leaderboard is empty. A truly historic economic collapse.');

  const lines = top.map((user, index) => `${index + 1}. ${user.name} — ${money(user.netWorth)} coins\n   ID: ${canonicalId(user.id)}`);
  return message.reply(`🏆 *TOP 10 NET WORTH*\n${lines.join('\n')}`);
}

function publicError(error) {
  const messages = {
    AMOUNT_REQUIRED: 'Specify an amount. Examples: `500`, `1.5k`, or `all` where supported.',
    INVALID_AMOUNT: 'That amount is invalid. Use a positive number with at most 2 decimals, optionally ending in k, m, or b.',
    MONEY_LIMIT: 'That transaction exceeds the bank’s safety limit. Try a smaller amount.',
    TARGET_REQUIRED: 'Choose a recipient using a WhatsApp mention or UID.',
    TARGET_INVALID: 'That recipient does not look like a WhatsApp UID/JID. Use a mention or a numeric UID.',
    TARGET_AMBIGUOUS: 'That UID matches more than one account. Mention the person or provide their full JID.',
    IDENTITY_AMBIGUOUS: 'Your current WhatsApp IDs match multiple stored accounts. Ask an admin to reconcile the duplicate account IDs.',
    IDENTITY_MISSING: 'Could not identify the sender from this event.',
    WALLET_INVALID: 'Your stored wallet value is invalid. The bank refused to change it to avoid losing money; ask an admin to inspect the user record.',
    CONCURRENT_UPDATE: 'Your account changed while this operation was running. No bank update was committed; retry once.',
    DUPLICATE_ACCOUNT_CHANGE: 'This transaction resolved two participants to the same account, so it was cancelled.',
    DATA_ALREADY_EXISTS: 'Your account was created by another operation. Run the command again.',
  };
  return messages[error && error.message] || 'The bank hit an internal error. Check both balances before retrying; the operation may need an admin inspection.';
}

module.exports = {
  config: {
    name: 'balance',
    aliases: ['bal', 'money', 'bank'],
    version: '2.0.0',
    author: 'Jsux',
    role: 0,
    category: 'economy',
    description: 'A full wallet, savings and questionable financial decisions system.',
    usage: '{pn} [deposit|withdraw|send|steal|daily|work|interest|history|top|help]'
  },

  async onStart({ args = [], message, event, usersData }) {
    return serializeOperation(async () => {
      const action = String(args[0] || '').trim().toLowerCase();
      const now = Date.now();

      try {
        if (action === 'help') return message.reply(helpText());
        if (['top', 'leaderboard', 'richest'].includes(action)) {
          return await doLeaderboard({ message, usersData, now });
        }

        const sender = await resolveSenderId(usersData, event || {});
        const loaded = await loadBankUser(usersData, sender.id, sender.aliases, event || {}, now);

        switch (action) {
          case 'deposit':
          case 'dep':
            return await doDeposit({ args, message, usersData, loaded, now });
          case 'withdraw':
          case 'with':
          case 'wd':
            return await doWithdraw({ args, message, usersData, loaded, now });
          case 'send':
          case 'transfer':
          case 'pay':
            return await doSend({ args, event: event || {}, message, usersData, loaded, now });
          case 'steal':
          case 'rob':
            return await doSteal({ args, event: event || {}, message, usersData, loaded, now });
          case 'daily':
            return await doDaily({ message, usersData, loaded, event: event || {}, now });
          case 'work':
            return await doWork({ message, usersData, loaded, event: event || {}, now });
          case 'interest':
          case 'rates':
            if (loaded.dirty) await commitChanges(usersData, [makeChange(loaded, undefined, loaded.account)]);
            return message.reply(interestText(loaded, now));
          case 'history':
          case 'transactions':
            if (loaded.dirty) await commitChanges(usersData, [makeChange(loaded, undefined, loaded.account)]);
            return await doHistory({ message, loaded });
          default:
            if (loaded.dirty) await commitChanges(usersData, [makeChange(loaded, undefined, loaded.account)]);
            return message.reply(accountSummary(loaded, now));
        }
      } catch (error) {
        const text = publicError(error);
        if (error && !Object.prototype.hasOwnProperty.call({
          AMOUNT_REQUIRED: 1, INVALID_AMOUNT: 1, MONEY_LIMIT: 1, TARGET_REQUIRED: 1,
          TARGET_INVALID: 1, TARGET_AMBIGUOUS: 1, IDENTITY_AMBIGUOUS: 1,
          IDENTITY_MISSING: 1, WALLET_INVALID: 1, CONCURRENT_UPDATE: 1,
          DUPLICATE_ACCOUNT_CHANGE: 1, DATA_ALREADY_EXISTS: 1
        }, error.message)) {
          try {
            if (typeof console !== 'undefined' && typeof console.error === 'function') {
              console.error('[bank command]', error);
            }
          } catch (_) {}
        }
        try {
          return await message.reply(text);
        } catch (_) {
          return undefined;
        }
      }
    });
  }
};
