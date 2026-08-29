const {
  scheduleTransaction,
  getPendingTransactions,
  getTransactionById,
  cancelTransaction,
  getDueTransactions,
  incrementAttempt,
  removeTransaction,
  recoverPendingJobs,
  reloadFromDisk,
  reset,
  clearAll,
} = require("../src/services/scheduledTransactionService");

describe("Scheduled Transaction Service", () => {
  const validPublicKey = "GAQWTE4AWTBZYJYZIURRBYD6G4N6WMB4QNY2OXZFTKRYR6XQ4OQK6R37";
  const validXDR = "AAAAAgAAAAD..."; // Dummy XDR

  beforeEach(() => {
    clearAll();
  });

  afterEach(() => {
    clearAll();
  });

  describe("Creating a schedule", () => {
    it("stores the expected fields", async () => {
      const submitAt = new Date(Date.now() + 10000);
      const scheduledTx = await scheduleTransaction(validXDR, submitAt, validPublicKey);

      expect(scheduledTx).toBeDefined();
      expect(scheduledTx.id).toBeDefined();
      expect(scheduledTx.signedXDR).toBe(validXDR);
      expect(scheduledTx.publicKey).toBe(validPublicKey);
      expect(scheduledTx.submitAt).toBe(submitAt.getTime());
      expect(scheduledTx.attempts).toBe(0);
      expect(scheduledTx.lastError).toBeNull();
      expect(scheduledTx.createdAt).toBeLessThanOrEqual(Date.now());

      const fetchedTx = getTransactionById(scheduledTx.id);
      expect(fetchedTx).toEqual(scheduledTx);
    });

    it("throws an error for invalid public key", async () => {
      const submitAt = new Date(Date.now() + 10000);
      await expect(scheduleTransaction(validXDR, submitAt, "invalid_key")).rejects.toThrow(
        "Invalid Stellar public key format"
      );
    });
  });

  describe("Due transactions execution", () => {
    it("returns transactions when their time arrives", async () => {
      const pastTime = new Date(Date.now() - 10000);
      const futureTime = new Date(Date.now() + 10000);

      const dueTx = await scheduleTransaction(validXDR, pastTime, validPublicKey);
      await scheduleTransaction(validXDR, futureTime, validPublicKey);

      const dueTransactions = getDueTransactions();

      const foundDue = dueTransactions.find(tx => tx.id === dueTx.id);
      const foundFuture = dueTransactions.find(tx => tx.submitAt === futureTime.getTime());

      expect(foundDue).toBeDefined();
      expect(foundFuture).toBeUndefined();
    });
  });

  describe("Failed executions (retries and marking failed)", () => {
    it("increments attempt and stores error", async () => {
      const pastTime = new Date(Date.now() - 10000);
      const tx = await scheduleTransaction(validXDR, pastTime, validPublicKey);

      const errorMessage = "Network timeout";
      await incrementAttempt(tx.id, errorMessage);

      const updatedTx = getTransactionById(tx.id);
      expect(updatedTx.attempts).toBe(1);
      expect(updatedTx.lastError).toBe(errorMessage);
    });

    it("stops returning transactions as due after 3 attempts", async () => {
      const pastTime = new Date(Date.now() - 10000);
      const tx = await scheduleTransaction(validXDR, pastTime, validPublicKey);

      await incrementAttempt(tx.id, "Error 1");
      let due = getDueTransactions().find(t => t.id === tx.id);
      expect(due).toBeDefined();

      await incrementAttempt(tx.id, "Error 2");
      due = getDueTransactions().find(t => t.id === tx.id);
      expect(due).toBeDefined();

      await incrementAttempt(tx.id, "Error 3");
      due = getDueTransactions().find(t => t.id === tx.id);
      expect(due).toBeUndefined();

      const updatedTx = getTransactionById(tx.id);
      expect(updatedTx.attempts).toBe(3);
    });
  });

  describe("Persistence", () => {
    it("persists scheduled transactions to disk", async () => {
      const submitAt = new Date(Date.now() + 10000);
      await scheduleTransaction(validXDR, submitAt, validPublicKey);

      reset();
      reloadFromDisk();

      const pending = getPendingTransactions(validPublicKey);
      expect(pending).toHaveLength(1);
    });

    it("recovers pending jobs on startup after reload", async () => {
      const submitAt = new Date(Date.now() + 10000);
      await scheduleTransaction(validXDR, submitAt, validPublicKey);

      reset();
      reloadFromDisk();

      const recovered = await recoverPendingJobs();

      const pending = getPendingTransactions(validPublicKey);
      expect(pending).toHaveLength(1);
      expect(recovered).toHaveLength(1);
      expect(pending[0].id).toBeDefined();
    });

    it("filters out failed transactions during recovery", async () => {
      const pastTime = new Date(Date.now() - 10000);
      const tx = await scheduleTransaction(validXDR, pastTime, validPublicKey);
      await incrementAttempt(tx.id, "Error 1");
      await incrementAttempt(tx.id, "Error 2");
      await incrementAttempt(tx.id, "Error 3");

      reset();
      reloadFromDisk();

      const recovered = await recoverPendingJobs();

      const pending = getPendingTransactions(validPublicKey);
      expect(pending).toHaveLength(0);
      expect(recovered).toHaveLength(0);
    });

    it("restores transaction counter after reload", async () => {
      await scheduleTransaction(validXDR, new Date(Date.now() + 10000), validPublicKey);
      await scheduleTransaction(validXDR, new Date(Date.now() + 20000), validPublicKey);

      reset();
      reloadFromDisk();

      await recoverPendingJobs();

      const submitAt = new Date(Date.now() + 30000);
      const scheduledTx = await scheduleTransaction(validXDR, submitAt, validPublicKey);
      expect(scheduledTx.id).toBe(3);
    });
  });
});
