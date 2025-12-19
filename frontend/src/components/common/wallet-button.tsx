import { useState } from "react";
import {
  useCurrentAccount,
  useDisconnectWallet,
  ConnectModal,
} from "@mysten/dapp-kit";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, LogOut, Wallet } from "lucide-react";
import { useSuiBalance } from "@/hooks/use-sui-balance";

const formatAddress = (address: string) =>
  `${address.slice(0, 6)}...${address.slice(-4)}`;

export default function WalletButton() {
  const account = useCurrentAccount();
  const { mutate: disconnect } = useDisconnectWallet();
  const [open, setOpen] = useState(false);
  const balance = useSuiBalance();

  if (!account) {
    return (
      <ConnectModal
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button onClick={() => setOpen(true)}>
            <Wallet className="mr-2 h-4 w-4" />
            Connect Wallet
          </Button>
        }
      />
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="font-mono gap-2">
          {formatAddress(account.address)}
          <ChevronDown className="h-4 w-4 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>My Wallet</DropdownMenuLabel>
        <DropdownMenuItem disabled className="flex justify-between">
          <span>$SUI</span>
          <span>
            {balance.data?.toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }) ?? "Loading..."}{" "}
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-red-600 focus:text-red-600 cursor-pointer"
          onClick={() => disconnect()}
        >
          <LogOut className="mr-2 h-4 w-4" />
          Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { WalletButton };
