import {
  initiateDeveloperControlledWalletsClient,
  type WalletSet,
} from '@circle-fin/developer-controlled-wallets';

let _client: ReturnType<typeof initiateDeveloperControlledWalletsClient> | null = null;

function getClient() {
  if (!_client) {
    _client = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY!,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
    });
  }
  return _client;
}

export async function createWalletSet(name: string): Promise<WalletSet> {
  const client = getClient();
  const res = await client.createWalletSet({ name });
  const walletSet = res.data?.walletSet;
  if (!walletSet) throw new Error('Circle did not return a walletSet');
  return walletSet;
}

export async function createWallet(walletSetId: string, blockchain: string = 'MATIC-AMOY') {
  const client = getClient();
  const res = await client.createWallets({
    walletSetId,
    blockchains: [blockchain as never],
    count: 1,
  });
  const wallet = res.data?.wallets?.[0];
  if (!wallet) throw new Error('Circle did not return a wallet');
  return wallet;
}

export async function getWalletBalance(walletId: string) {
  const client = getClient();
  const res = await client.getWalletTokenBalance({ id: walletId });
  return res.data?.tokenBalances ?? [];
}

export async function transferUsdc(params: {
  walletId: string;
  destinationAddress: string;
  amountUsdc: string;
  blockchain?: string;
}) {
  const client = getClient();
  interface CreateTransactionData {
    id?: string
    transactionId?: string
  }

  const res = await client.createTransaction({
    walletId: params.walletId,
    tokenId: process.env.USDC_TOKEN_ID ?? '',
    destinationAddress: params.destinationAddress,
    amount: [params.amountUsdc],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  } as Parameters<typeof client.createTransaction>[0]);
  const data = res.data as CreateTransactionData | undefined
  return data?.id ?? data?.transactionId;
}
