import { useState } from "react";
import { Rail, type Screen } from "./components/Rail";
import { ForgeScreen } from "./screens/ForgeScreen";
import { PacksScreen } from "./screens/PacksScreen";
import { HistoryScreen } from "./screens/HistoryScreen";
import { SettingsScreen } from "./screens/SettingsScreen";

export function App() {
  const [screen, setScreen] = useState<Screen>("forge");
  const [chatId, setChatId] = useState<string | null>(null);
  // A request typed for the user (Quests tab Edit buttons): opens a new chat with it in the composer.
  const [prefill, setPrefill] = useState<string | null>(null);
  return (
    <div className="flex h-full bg-bg text-text">
      <Rail current={screen} onGo={setScreen} />
      {screen === "forge" && <ForgeScreen chatId={chatId} onChatChange={setChatId} onGoSettings={() => setScreen("settings")} prefill={prefill} onPrefillTaken={() => setPrefill(null)} />}
      {screen === "packs" && <PacksScreen onGoSettings={() => setScreen("settings")} onPrefill={(text) => { setChatId(null); setPrefill(text); setScreen("forge"); }} />}
      {screen === "history" && <HistoryScreen onOpen={(id) => { setChatId(id); setScreen("forge"); }} onDeleted={(ids) => { if (ids === "all" || (chatId && ids.includes(chatId))) setChatId(null); }} />}
      {screen === "settings" && <SettingsScreen onStart={() => setScreen("forge")} />}
    </div>
  );
}
