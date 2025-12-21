import { Outlet } from "react-router-dom";
import { WalletButton } from "@/components/common/wallet-button";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";

export function AppLayout() {
  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <header className="flex justify-between items-center p-4 border-b bg-white">
        <Link to="/">SuiStream</Link>
        <WalletButton />
      </header>

      <main className="flex-1 p-4 lg:p-8">
        <div className="max-w-2xl mx-auto">
          <Outlet />
        </div>
      </main>

      <footer className="border-t p-4 text-sm text-gray-500 text-center">
        <Button variant="link" asChild>
          <a
            href="https://github.com/ndhu-blockchain/SuiStream"
            target="_blank"
          >
            GitHub Repository
          </a>
        </Button>
        <span className="flex flex-wrap items-center justify-center">
          <p>Developed by</p>
          <Button variant="link" className="px-1 py-1" asChild>
            <a href="https://github.com/jhihyulin" target="_blank">
              Thomas Lin
            </a>
          </Button>
          &
          <Button variant="link" className="px-1 py-1" asChild>
            <a href="https://github.com/yilun9676" target="_blank">
              Alan Lee
            </a>
          </Button>
          in
          <Button variant="link" className="px-1 py-1" asChild>
            <a href="https://ndhublockchain.club" target="_blank">
              NDHU Blockchain Club
            </a>
          </Button>
        </span>
      </footer>
      <Toaster />
    </div>
  );
}
