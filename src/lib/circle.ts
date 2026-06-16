import {
  initiateUserControlledWalletsClient,
  type WalletSet,
} from '@circle-fin/developer-controlled-wallets';

let _client: ReturnType<typeof initiateUserControlledWalletsClient> | null = null;

function getClient() {
  if (!_client) {
    _client = initiateUserControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY!,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
    });
  }
  return _client;
}

export async function createWalletSet(name: string): Promise<WalletSet> {
  const client = getClient();
  const res = await client.createWalletSet({ name });
  return res.data!.walletSet!;
}

export async function createWallet(walletSetId: string, blockchain: string = 'MATIC-AMOY') {
  const client = getClient();
  const res = await client.createWallets({
    walletSetId,
    blockchains: [blockchain as never],
    count: 1,
  });
  return res.data!.wallets![0];
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
  const res = await client.createTransaction({
    walletId: params.walletId,
    tokenId: process.env.USDC_TOKEN_ID ?? '',
    destinationAddress: params.destinationAddress,
    amounts: [params.amountUsdc],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  });
  return res.data?.transaction;
}
