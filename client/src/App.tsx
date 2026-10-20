import { CoachPage } from "./pages/CoachPage";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { DeckPage } from "./pages/DeckPage";
import { DecksPage } from "./pages/DecksPage";
import { ImportPage } from "./pages/ImportPage";
import { AdminPage } from "./pages/AdminPage";
import { AgentsPage } from "./pages/AgentsPage";
import { LibraryDeckPage } from "./pages/LibraryDeckPage";
import { LibraryPage } from "./pages/LibraryPage";
import { PlayPage } from "./pages/PlayPage";
import { RoomPage } from "./pages/RoomPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SearchPage } from "./pages/SearchPage";
import { SettingsPage } from "./pages/SettingsPage";
import { StoresPage } from "./pages/StoresPage";
import { DeckStatsPage } from "./pages/DeckStatsPage";
import { SignInPage, SignUpPage } from "./pages/AccountPages";
import { FriendsPage } from "./pages/FriendsPage";
import { Landing, StartPage, WelcomePage } from "./pages/WelcomePage";
import { NotificationsProvider } from "./components/Bell";
import { SettingsProvider } from "./settings";
import { UserProvider } from "./user";

export function App() {
  return (
    <BrowserRouter>
      <UserProvider>
        <SettingsProvider>
          <NotificationsProvider>
          <div className="app-shell">
          <Header />
          <Routes>
            <Route path="/" element={<Landing app={<DecksPage />} />} />
            <Route path="/welcome" element={<WelcomePage />} />
            <Route path="/start" element={<StartPage />} />
            <Route path="/friends" element={<FriendsPage />} />
            <Route path="/cards" element={<SearchPage />} />
            <Route path="/decks/new" element={<ImportPage />} />
            <Route path="/decks/:id" element={<DeckPage />} />
            <Route path="/me" element={<ProfilePage />} />
            <Route path="/signin" element={<SignInPage />} />
            <Route path="/signup" element={<SignUpPage />} />
            <Route path="/play" element={<PlayPage />} />
            <Route path="/room/:code" element={<RoomPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/stores" element={<StoresPage />} />
            <Route path="/stats" element={<DeckStatsPage />} />
            <Route path="/coach/:code" element={<CoachPage />} />
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/admin/library" element={<LibraryPage />} />
            <Route path="/admin/library/:id" element={<LibraryDeckPage />} />
            <Route path="/admin/agents" element={<AgentsPage />} />
            <Route path="*" element={<Landing app={<DecksPage />} />} />
          </Routes>
          <Footer />
          </div>
          </NotificationsProvider>
        </SettingsProvider>
      </UserProvider>
    </BrowserRouter>
  );
}
