import { WalletButton } from "@/components/common/wallet-button";
import { Button } from "@/components/ui/button";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { Link } from "react-router-dom";

export default function Home() {
  const walletConnected = Boolean(useCurrentAccount());

  return (
    <div className="flex flex-col items-center justify-center min-h-screen">
      <h1 className="text-4xl font-bold mb-4">Welcome to SuiStream</h1>
      <p className="text-lg mb-8">Connect your wallet to get started.</p>
      {!walletConnected ? (
        <WalletButton />
      ) : (
        <div className="flex space-x-4">
          <Button>
            <Link to="/videos">Videos</Link>
          </Button>
          <Button>
            <Link to="/upload">Upload</Link>
          </Button>
        </div>
      )}
    </div>
  );
}

export { Home };
