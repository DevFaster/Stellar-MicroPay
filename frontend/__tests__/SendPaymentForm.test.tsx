import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import SendPaymentForm from "@/components/SendPaymentForm";
import { useWallet } from "@/lib/useWallet";

jest.mock("@/lib/useWallet");

jest.mock("@/lib/wallet", () => ({
  __esModule: true,
  signTransactionWithWallet: jest.fn(),
  setJwtToken: jest.fn(),
  getJwtToken: jest.fn(),
  detectBrowser: jest.fn(),
  EXTENSION_URLS: {},
  isFreighterInstalled: jest.fn(() => Promise.resolve(true)),
  hasSiteAccess: jest.fn(() => Promise.resolve(true)),
  connectWallet: jest.fn(),
  getConnectedPublicKey: jest.fn(),
  performSEP0010Auth: jest.fn(),
  disconnectWallet: jest.fn(),
  isLedgerSupported: jest.fn(() => false),
  signTransactionWithLedger: jest.fn(),
  getLedgerPublicKey: jest.fn(),
}));

jest.mock("@/lib/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === "send_button") {
        const amount = (opts?.amount as string) || "";
        const asset = (opts?.asset as string) || "XLM";
        if (amount) return `Send ${amount} ${asset}`;
        return "Send";
      }
      if (key === "confirm_sign") return "Confirm & Sign";
      if (key === "amount_placeholder") return "0.0000000";
      if (key === "memo_placeholder") return "Optional memo";
      if (key === "memo_optional") return "Memo (optional)";
      if (key === "destination") return "Destination";
      if (key === "amount") return "Amount";
      if (key === "max") return "Max";
      if (key === "contacts") return "contacts";
      if (key === "save_contact") return "Save address as contact";
      if (key === "processing") return "Processing";
      if (key === "cancel") return "Cancel";
      if (key === "send_another") return "Send Another";
      if (key === "success_title") return "Payment Sent";
      if (key === "success_message") return "Your transaction has been submitted.";
      if (key === "transaction_hash") return "Transaction Hash";
      if (key === "view_explorer") return "View on Explorer";
      if (key === "mint_receipt") return "Mint Receipt";
      if (key === "minting_receipt") return "Minting Receipt...";
      if (key === "mint_success") return "Receipt minted!";
      if (key === "high_value_warning") return "High-value payment. Consider using Multi-Signature.";
      if (key === "checking_account") return "Checking account...";
      if (key === "confirm_title") return "Confirm Payment";
      if (key === "to") return "To";
      if (key === "estimated_fee") return "Estimated fee";
      return key;
    },
  }),
}));

const mockAddToast = jest.fn();

jest.mock("@/lib/ToastContext", () => ({
  useToastContext: () => ({
    addToast: mockAddToast,
    removeToast: jest.fn(),
    toasts: [],
  }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock("@/lib/stellar", () => ({
  buildPaymentTransaction: jest.fn(),
  buildSorobanTipTransaction: jest.fn(),
  buildReceiptMintTransaction: jest.fn(),
  CONTRACT_ID: null,
  explorerUrl: jest.fn((hash) => `https://testnet.expert.stellar.org/tx/${hash}`),
  isValidStellarAddress: jest.fn((addr) => addr.startsWith("G") && addr.length === 56),
  isValidFederationAddress: jest.fn((addr) => addr.includes("*")),
  isStellarName: jest.fn((name: string) => name.endsWith(".xlm") || name.includes("*")),
  resolveStellarName: jest.fn(() => Promise.resolve("GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3D5NZ2KMSUGSRNVO7ZFGIGSZZZ")),
  resolveFederationAddress: jest.fn(),
  resolveStellarName: jest.fn(),
  signTransactionWithWallet: jest.fn(),
  submitTransaction: jest.fn(),
  fetchNetworkFeeStats: jest.fn(() => Promise.resolve({ baseFeeXlm: 0.00001, feeLevel: "normal" })),
  truncateMemoText: jest.fn((text: string) => text),
  STELLAR_BASE_FEE_XLM: 0.00001,
  STELLAR_MEMO_TEXT_MAX_BYTES: 28,
  STELLAR_MINIMUM_ACCOUNT_BALANCE_XLM: 1,
  server: {
    loadAccount: jest.fn(() => Promise.reject(new Error("Account not found"))),
    payments: jest.fn(),
    transactions: jest.fn(),
  },
}));

jest.mock("@/components/PaymentStatusModal", () => ({
  __esModule: true,
  default: ({ isOpen, error, txHash, onClose }: any) => {
    if (!isOpen) return null;
    return (
      <div data-testid="payment-status-modal">
        {error && <div data-testid="error-message">{error}</div>}
        {txHash && <div data-testid="tx-hash">{txHash}</div>}
        <button onClick={onClose}>Close</button>
      </div>
    );
  },
}));

const defaultProps = {
  publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  xlmBalance: "100.0000000",
  onSuccess: jest.fn(),
  onError: jest.fn(),
};

import SendPaymentForm from "../components/SendPaymentForm";
import * as stellarModule from "@/lib/stellar";
import * as walletModule from "@/lib/wallet";
import { TEST_PUBLIC_KEY_A, TEST_PUBLIC_KEY_B } from "./fixtures/stellar";

const mockBuildPaymentTransaction = stellarModule.buildPaymentTransaction as jest.Mock;
const mockIsValidStellarAddress = stellarModule.isValidStellarAddress as jest.Mock;
const mockSubmitTransaction = stellarModule.submitTransaction as jest.Mock;
const mockFetchNetworkFeeStats = stellarModule.fetchNetworkFeeStats as jest.Mock;
const mockSignTransactionWithWallet = walletModule.signTransactionWithWallet as jest.Mock;

describe("SendPaymentForm", () => {
  const defaultProps = {
    publicKey: TEST_PUBLIC_KEY_A,
    xlmBalance: "100.0000000",
    usdcBalance: "50.0000000",
    onSuccess: jest.fn(),
  };

  const validDestination = TEST_PUBLIC_KEY_B;
  beforeEach(() => {
    jest.clearAllMocks();
    mockAddToast.mockReset();
    const stellarMocks = jest.requireMock("@/lib/stellar");
    stellarMocks.buildPaymentTransaction.mockReset();
    stellarMocks.buildPaymentTransaction.mockResolvedValue({
      toXDR: () => "mock-xdr",
    });
    stellarMocks.submitTransaction.mockReset();
    stellarMocks.submitTransaction.mockResolvedValue({ hash: "tx123456" });
    stellarMocks.signTransactionWithWallet.mockReset();
    stellarMocks.signTransactionWithWallet.mockResolvedValue({
      signedXDR: "mock-signed-xdr",
    });
    stellarMocks.server.loadAccount.mockReset();
    stellarMocks.server.loadAccount.mockResolvedValue({});
    stellarMocks.server.transactions.mockReset();
    stellarMocks.server.transactions.mockReturnValue({
      transaction: jest.fn(() => ({
        call: jest.fn(() => Promise.resolve({})),
      })),
    });
    stellarMocks.isValidStellarAddress.mockReturnValue(true);
    const walletMocks = jest.requireMock("@/lib/wallet");
    walletMocks.signTransactionWithWallet.mockReset();
    walletMocks.signTransactionWithWallet.mockResolvedValue({
      signedXDR: "mock-signed-xdr",
    });
    (useWallet as jest.MockedFunction<typeof useWallet>).mockReturnValue({
      publicKey: defaultProps.publicKey,
      isConnected: true,
      isLoading: false,
      signTransaction: jest.fn(),
      sendTransaction: jest.fn(),
      connect: jest.fn(),
      disconnect: jest.fn(),
    } as any);
  });

  it("renders the form with memo field and send button", () => {
    render(<SendPaymentForm {...defaultProps} />);
    expect(screen.getByText("Memo (optional)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Send/i })).toBeInTheDocument();
  });

  describe("Duplicate submission guard (#736)", () => {
    it("ignores double-click on the send button", async () => {
      const stellarMocks = jest.requireMock("@/lib/stellar");
      const user = userEvent.setup();
      render(<SendPaymentForm {...defaultProps} />);

      const destinationInput = screen.getByPlaceholderText(/G\.\.\./);
      const amountInput = screen.getByPlaceholderText("0.0000000");

      fireEvent.change(destinationInput, { target: { value: validDestination } });
      fireEvent.change(amountInput, { target: { value: "50" } });

      const sendButton = screen.getByRole("button", { name: /Send 50 XLM/i });

      await waitFor(() => {
        expect(sendButton).toBeEnabled();
      });

      await user.dblClick(sendButton);

      const confirmButton = await screen.findByRole("button", { name: /Confirm & Sign/i });
      await user.click(confirmButton);

      await waitFor(() => {
        expect(stellarMocks.buildPaymentTransaction).toHaveBeenCalledTimes(1);
      });
    });

    it("ignores double-click on the confirm button", async () => {
      const stellarMocks = jest.requireMock("@/lib/stellar");
      const user = userEvent.setup();
      render(<SendPaymentForm {...defaultProps} />);

      const destinationInput = screen.getByPlaceholderText(/G\.\.\./);
      const amountInput = screen.getByPlaceholderText("0.0000000");

      fireEvent.change(destinationInput, { target: { value: validDestination } });
      fireEvent.change(amountInput, { target: { value: "50" } });

      const sendButton = screen.getByRole("button", { name: /Send 50 XLM/i });

      await waitFor(() => {
        expect(sendButton).toBeEnabled();
      });

      await user.click(sendButton);

      const confirmButton = await screen.findByRole("button", { name: /Confirm & Sign/i });
      await user.dblClick(confirmButton);

      await waitFor(() => {
        expect(stellarMocks.submitTransaction).toHaveBeenCalledTimes(1);
      });
    });

    it("ignores repeated Enter key in confirmation modal", async () => {
      const stellarMocks = jest.requireMock("@/lib/stellar");
      const user = userEvent.setup();
      render(<SendPaymentForm {...defaultProps} />);

      const destinationInput = screen.getByPlaceholderText(/G\.\.\./);
      const amountInput = screen.getByPlaceholderText("0.0000000");

      fireEvent.change(destinationInput, { target: { value: validDestination } });
      fireEvent.change(amountInput, { target: { value: "50" } });

      const sendButton = screen.getByRole("button", { name: /Send 50 XLM/i });

      await waitFor(() => {
        expect(sendButton).toBeEnabled();
      });

      await user.click(sendButton);

      const confirmButton = await screen.findByRole("button", { name: /Confirm & Sign/i });
      confirmButton.focus();
      await user.keyboard("{Enter}");
      await user.keyboard("{Enter}");

      await waitFor(() => {
        expect(stellarMocks.submitTransaction).toHaveBeenCalledTimes(1);
      });
    });

    it("reuses the same transaction on retry after error", async () => {
      const stellarMocks = jest.requireMock("@/lib/stellar");
      const user = userEvent.setup();
      render(<SendPaymentForm {...defaultProps} />);

      const destinationInput = screen.getByPlaceholderText(/G\.\.\./);
      const amountInput = screen.getByPlaceholderText("0.0000000");

      fireEvent.change(destinationInput, { target: { value: validDestination } });
      fireEvent.change(amountInput, { target: { value: "50" } });

      const sendButton = screen.getByRole("button", { name: /Send 50 XLM/i });

      await waitFor(() => {
        expect(sendButton).toBeEnabled();
      });

      stellarMocks.submitTransaction
        .mockRejectedValueOnce(new Error("Network timeout"))
        .mockResolvedValueOnce({ hash: "tx123456" });

      await user.click(sendButton);

      const confirmButton = await screen.findByRole("button", { name: /Confirm & Sign/i });
      await user.click(confirmButton);

      await waitFor(() => {
        expect(screen.getByTestId("error-message")).toHaveTextContent("Network timeout");
      });

      await waitFor(() => {
        expect(stellarMocks.buildPaymentTransaction).toHaveBeenCalledTimes(1);
      });

      const retryCallback = mockAddToast.mock.calls[0][2];
      if (retryCallback) {
        retryCallback();
      }

      await waitFor(() => {
        expect(screen.getByText("Payment Sent")).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(screen.getByText(/tx123456…123456/)).toBeInTheDocument();
      });

      expect(stellarMocks.buildPaymentTransaction).toHaveBeenCalledTimes(1);
    });
  });
});
