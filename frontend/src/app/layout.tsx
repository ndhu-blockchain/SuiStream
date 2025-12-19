import { Outlet } from "react-router-dom";
import { WalletButton } from "@/components/common/wallet-button";

export function AppLayout() {
  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <header className="flex justify-between items-center p-4 border-b bg-white">
        <span className="text-xl font-bold">SuiStream</span>
        <WalletButton />
      </header>

      <main className="flex-1 p-8">
        <div className="max-w-2xl mx-auto">
          <Outlet />
        </div>
      </main>

      <footer className="border-t p-4 text-sm text-gray-500 text-center">
        SuiStream
      </footer>
    </div>
  );
}
