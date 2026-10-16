import { Footer } from "./components/Footer";
import { SearchPage } from "./pages/SearchPage";

export function App() {
  return (
    <div className="app-shell">
      <SearchPage />
      <Footer />
    </div>
  );
}
