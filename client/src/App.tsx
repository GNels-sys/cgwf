import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Footer } from "./components/Footer";
import { Header } from "./components/Header";
import { DeckPage } from "./pages/DeckPage";
import { DecksPage } from "./pages/DecksPage";
import { ImportPage } from "./pages/ImportPage";
import { AgentsPage } from "./pages/AgentsPage";
import { LibraryDeckPage } from "./pages/LibraryDeckPage";
import { LibraryPage } from "./pages/LibraryPage";
import { PlayPage } from "./pages/PlayPage";
import { RoomPage } from "./pages/RoomPage";
import { ProfilePage } from "./pages/ProfilePage";
import { SearchPage } from "./pages/SearchPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SignInPage, SignUpPage } from "./pages/AccountPages";
import { SettingsProvider } from "./settings";
import { UserProvider } from "./user";

export function App() {
  return (
    <BrowserRouter>
      <UserProvider>
        <SettingsProvider>
          <div className="app-shell">
          <Header />
          <Routes>
            <Route path="/" element={<DecksPage />} />
            <Route path="/cards" element={<SearchPage />} />
            <Route path="/decks/new" element={<ImportPage />} />
            <Route path="/decks/:id" element={<DeckPage />} />
            <Route path="/me" element={<ProfilePage />} />
            <Route path="/signin" element={<SignInPage />} />
            <Route path="/signup" element={<SignUpPage />} />
            <Route path="/play" element={<PlayPage />} />
            <Route path="/room/:code" element={<RoomPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/admin/library" element={<LibraryPage />} />
            <Route path="/admin/library/:id" element={<LibraryDeckPage />} />
            <Route path="/admin/agents" element={<AgentsPage />} />
            <Route path="*" element={<DecksPage />} />
          </Routes>
          <Footer />
          </div>
        </SettingsProvider>
      </UserProvider>
    </BrowserRouter>
  );
}
