import { Outlet } from "react-router-dom";
import { WalletButton } from "@/components/common/wallet-button";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";

export function AppLayout() {
  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <header className="flex justify-between items-center p-4 border-b bg-white">
        <Link to="/">SuiStream</Link>
        <WalletButton />
      </header>

      <main className="flex-1 p-8">
        <div className="max-w-2xl mx-auto">
          <Outlet />
        </div>
      </main>

      <footer className="border-t p-4 text-sm text-gray-500 text-center">
        <Button variant="link">
          <a
            href="https://github.com/ndhu-blockchain/SuiStream"
            target="_blank"
          >
            GitHub Repository
          </a>
        </Button>
      </footer>
    </div>
  );
}
