"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "scheduled-transactions.json");
require("dotenv").config();
const logger = require("../utils/logger");

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
    // Reconciliation state: null | "unknown" | "confirmed" | "failed"
    submissionState: null,
    /** @type {string|null} Transaction hash after submission */
    txHash: null,
    /** @type {string|null} Source account sequence number from the XDR */
    sourceSequence: null,
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
    // Only include transactions that:
    // 1. Are due for submission (submitAt <= now)
    // 2. Haven't exceeded max attempts (attempts < 3)
    // 3. Are not paused (paused !== true)
    // 4. Haven't already been submitted or reconciled (avoids duplicate resubmission)
    if (
      tx.submitAt <= now &&
      tx.attempts < 3 &&
      !tx.paused &&
      tx.submissionState !== "confirmed" &&
      tx.submissionState !== "unknown"
    ) {
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

/**
 * Record a submission attempt. Sets state to "unknown" until reconciliation.
 * @param {number} id - The transaction ID
 * @param {string} txHash - The Stellar transaction hash
 * @param {string} [sourceSequence] - The source account sequence used in the XDR
 */
function markSubmitted(id, txHash, sourceSequence) {
  const tx = scheduledTransactions.get(id);
  if (tx) {
    tx.submissionState = "unknown";
    tx.txHash = txHash;
    if (sourceSequence) tx.sourceSequence = sourceSequence;
    logger.info(JSON.stringify({ type: "transaction_submitted", id, txHash }));
  }
}

/**
 * Reconcile a submitted transaction by confirming or denying it.
 * When the caller has checked Horizon and determined the outcome, they call
 * this function to move the transaction to a terminal state.
 *
 * @param {number} id - The transaction ID
 * @param {boolean} confirmed - Whether the transaction was found on-ledger
 * @param {string} [reason] - Explanation (e.g. timeout, duplicate, bad_seq)
 */
function reconcileTransaction(id, confirmed, reason) {
  const tx = scheduledTransactions.get(id);
  if (!tx) return;

  if (confirmed) {
    tx.submissionState = "confirmed";
    logger.info(JSON.stringify({ type: "transaction_confirmed", id, txHash: tx.txHash }));
  } else {
    tx.submissionState = "failed";
    tx.lastError = reason || "Reconciled as not found on-ledger";
    logger.info(JSON.stringify({ type: "transaction_failed_reconciliation", id, reason: tx.lastError }));
  }
}

/**
 * Reconcile by looking up a transaction hash on Horizon.
 * Returns the resolved state so the caller can act on it.
 *
 * @param {number} id - The transaction ID
 * @param {object|null} horizonTx - The Horizon transaction response, or null if not found
 * @returns {string} "confirmed" | "failed" | "unknown"
 */
function reconcileByHash(id, horizonTx) {
  const tx = scheduledTransactions.get(id);
  if (!tx) return "unknown";

  if (horizonTx && (horizonTx.successful === true || horizonTx.successful === undefined)) {
    reconcileTransaction(id, true);
    return "confirmed";
  }

  // Found on-ledger but not successful, or not found at all
  reconcileTransaction(id, false, horizonTx ? "Transaction failed on-ledger" : "Transaction not found");
  return "failed";
}

/**
 * Reconcile by comparing the account's current sequence to the source
 * sequence that was used when the transaction was signed.
 *
 * If the account's sequence has advanced past the source sequence, the
 * transaction (or a subsequent one using the same sequence) has been applied.
 *
 * @param {number} id - The transaction ID
 * @param {string|number} currentSequence - The account's current sequence from Horizon
 * @returns {string} "confirmed" | "failed" | "unknown"
 */
function reconcileBySequence(id, currentSequence) {
  const tx = scheduledTransactions.get(id);
  if (!tx) return "unknown";
  if (!tx.sourceSequence) return "unknown";

  const current = BigInt(currentSequence);
  const source = BigInt(tx.sourceSequence);

  if (current > source) {
    // Sequence advanced — the transaction was applied (or superseded).
    reconcileTransaction(id, true, "Sequence advanced past source");
    return "confirmed";
  }

  // Sequence hasn't advanced — transaction was never applied
  reconcileTransaction(id, false, "Sequence unchanged — transaction not applied");
  return "failed";
}

/**
 * Get all transactions that need reconciliation (submitted but outcome unknown).
 * @returns {Array}
 */
function getUnreconciledTransactions() {
  const unreconciled = [];
  for (const [, tx] of scheduledTransactions.entries()) {
    if (tx.submissionState === "unknown") {
      unreconciled.push(tx);
    }
  }
  return unreconciled;
}

/**
 * Pause a scheduled transaction
 * @param {number} id - The transaction ID
 * @returns {boolean} True if paused, false if not found
 */
async function pauseTransaction(id) {
  const tx = scheduledTransactions.get(id);
  if (tx) {
    tx.paused = true;
    tx.pausedAt = Date.now();
    logger.info(JSON.stringify({ type: "transaction_paused", id }));
    await persistToDisk();
    return true;
  }
  return false;
}

/**
 * Resume a paused scheduled transaction
 * @param {number} id - The transaction ID
 * @returns {boolean} True if resumed, false if not found
 */
async function resumeTransaction(id) {
  const tx = scheduledTransactions.get(id);
  if (tx) {
    tx.paused = false;
    tx.pausedAt = null;
    logger.info(JSON.stringify({ type: "transaction_resumed", id }));
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
  markSubmitted,
  reconcileTransaction,
  reconcileByHash,
  reconcileBySequence,
  getUnreconciledTransactions,
  recoverPendingJobs,
  reloadFromDisk: loadFromDisk,
  reset,
  clearAll,
};
