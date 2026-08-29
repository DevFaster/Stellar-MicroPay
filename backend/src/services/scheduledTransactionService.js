"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "scheduled-transactions.json");

const scheduledTransactions = new Map();
let transactionIdCounter = 1;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadFromDisk() {
  try {
    ensureDataDir();
    if (fs.existsSync(DATA_FILE)) {
      const content = fs.readFileSync(DATA_FILE, "utf8");
      const data = JSON.parse(content);
      scheduledTransactions.clear();
      for (const [id, tx] of Object.entries(data.transactions || {})) {
        scheduledTransactions.set(Number(id), tx);
      }
      const maxId = Math.max(
        ...Object.keys(data.transactions || {}).map(Number),
        0
      );
      transactionIdCounter = maxId + 1;
    }
  } catch (err) {
    console.error("Failed to load scheduled transactions from disk", err);
  }
}

async function persistToDisk() {
  try {
    ensureDataDir();
    const transactions = {};
    for (const [id, tx] of scheduledTransactions.entries()) {
      transactions[id] = tx;
    }
    const data = {
      nextId: transactionIdCounter,
      transactions,
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to persist scheduled transactions to disk", err);
  }
}

async function recoverPendingJobs() {
  const now = Date.now();
  const recovered = [];
  for (const [id, tx] of scheduledTransactions.entries()) {
    if (tx.attempts >= 3) {
      scheduledTransactions.delete(id);
    } else {
      recovered.push(tx);
    }
  }
  await persistToDisk();
  return recovered;
}

function reset() {
  scheduledTransactions.clear();
  transactionIdCounter = 1;
}

function clearAll() {
  reset();
  try {
    if (fs.existsSync(DATA_FILE)) {
      fs.unlinkSync(DATA_FILE);
    }
  } catch (err) {
    console.error("Failed to clear scheduled transactions file", err);
  }
}

loadFromDisk();

function validatePublicKey(publicKey) {
  if (!/^G[A-Z0-9]{55}$/.test(publicKey)) {
    const error = new Error("Invalid Stellar public key format");
    error.status = 400;
    throw error;
  }
}

async function scheduleTransaction(signedXDR, submitAt, publicKey) {
  if (!signedXDR || typeof signedXDR !== "string") {
    const error = new Error("Signed XDR is required and must be a string");
    error.status = 400;
    throw error;
  }

  if (!(submitAt instanceof Date) || isNaN(submitAt.getTime())) {
    const error = new Error("submitAt must be a valid Date object");
    error.status = 400;
    throw error;
  }

  validatePublicKey(publicKey);

  const id = transactionIdCounter++;
  const scheduledTx = {
    id,
    signedXDR,
    submitAt: submitAt.getTime(),
    publicKey,
    attempts: 0,
    lastError: null,
    createdAt: new Date().getTime(),
    paused: false,
    pausedAt: null,
  };

  scheduledTransactions.set(id, scheduledTx);
  await persistToDisk();
  return scheduledTx;
}

function getPendingTransactions(publicKey) {
  validatePublicKey(publicKey);

  const now = Date.now();
  const pending = [];

  for (const [, tx] of scheduledTransactions.entries()) {
    if (tx.publicKey === publicKey && tx.submitAt > now && tx.attempts < 3 && !tx.paused) {
      pending.push({
        id: tx.id,
        submitAt: new Date(tx.submitAt),
        publicKey: tx.publicKey,
        attempts: tx.attempts,
        createdAt: new Date(tx.createdAt),
        paused: tx.paused || false,
      });
    }
  }

  return pending.sort((a, b) => a.submitAt - b.submitAt);
}

function getTransactionById(id) {
  return scheduledTransactions.get(id) || null;
}

async function cancelTransaction(id) {
  const result = scheduledTransactions.delete(id);
  if (result) {
    await persistToDisk();
  }
  return result;
}

function getDueTransactions() {
  const now = Date.now();
  const due = [];

  for (const [, tx] of scheduledTransactions.entries()) {
    if (tx.submitAt <= now && tx.attempts < 3 && !tx.paused) {
      due.push(tx);
    }
  }

  return due.sort((a, b) => a.submitAt - b.submitAt);
}

async function incrementAttempt(id, error = null) {
  const tx = scheduledTransactions.get(id);
  if (tx) {
    tx.attempts += 1;
    tx.lastError = error || null;
    await persistToDisk();
  }
}

async function removeTransaction(id) {
  const result = scheduledTransactions.delete(id);
  if (result) {
    await persistToDisk();
  }
  return result;
}

async function pauseTransaction(id) {
  const tx = scheduledTransactions.get(id);
  if (tx) {
    tx.paused = true;
    tx.pausedAt = Date.now();
    console.info("transaction_paused", JSON.stringify({ type: "transaction_paused", id }));
    await persistToDisk();
    return true;
  }
  return false;
}

async function resumeTransaction(id) {
  const tx = scheduledTransactions.get(id);
  if (tx) {
    tx.paused = false;
    tx.pausedAt = null;
    console.info("transaction_resumed", JSON.stringify({ type: "transaction_resumed", id }));
    await persistToDisk();
    return true;
  }
  return false;
}

module.exports = {
  scheduleTransaction,
  getPendingTransactions,
  getTransactionById,
  cancelTransaction,
  getDueTransactions,
  incrementAttempt,
  removeTransaction,
  pauseTransaction,
  resumeTransaction,
  recoverPendingJobs,
  reloadFromDisk: loadFromDisk,
  reset,
  clearAll,
};
