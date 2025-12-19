import { useCurrentAccount, useSuiClient } from "@mysten/dapp-kit";
import { useQuery } from "@tanstack/react-query";
import { SUI_COIN_TYPE, MIST_PER_SUI } from "@/lib/sui";

export default function useSuiBalance() {
  const account = useCurrentAccount();
  const client = useSuiClient();

  return useQuery({
    queryKey: ["sui-balance", account?.address],
    enabled: !!account,
    queryFn: async () => {
      const res = await client.getBalance({
        owner: account!.address,
        coinType: SUI_COIN_TYPE,
      });
      return Number(res.totalBalance) / MIST_PER_SUI;
    },
  });
}

export { useSuiBalance };
