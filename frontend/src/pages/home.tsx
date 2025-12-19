import { WalletButton } from "@/components/common/wallet-button";

export default function Home() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen">
      <h1 className="text-4xl font-bold mb-4">Welcome to SuiStream</h1>
      <p className="text-lg mb-8">Connect your wallet to get started.</p>
      <WalletButton />
    </div>
  );
}
