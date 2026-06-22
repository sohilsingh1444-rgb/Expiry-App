import { Component, type ReactNode } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OfflineBanner } from "@/components/offline-banner";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import AdminPage from "@/pages/admin";
import ItUploadPage from "@/pages/it-upload";

const queryClient = new QueryClient();

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", padding: "2rem", fontFamily: "sans-serif", background: "#f9fafb" }}>
          <div style={{ background: "#fff", border: "1px solid #fca5a5", borderRadius: 12, padding: "2rem", maxWidth: 420, width: "100%", textAlign: "center", boxShadow: "0 2px 16px rgba(0,0,0,0.07)" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
            <h2 style={{ color: "#b91c1c", marginBottom: 8, fontSize: 18 }}>Something went wrong</h2>
            <p style={{ color: "#6b7280", fontSize: 14, marginBottom: 20 }}>The app encountered an unexpected error. Please reload to continue.</p>
            <button
              onClick={() => window.location.reload()}
              style={{ background: "#f97316", color: "#fff", border: "none", borderRadius: 8, padding: "10px 28px", fontSize: 15, fontWeight: 600, cursor: "pointer" }}
            >
              Reload App
            </button>
            <details style={{ marginTop: 16, textAlign: "left" }}>
              <summary style={{ color: "#9ca3af", fontSize: 12, cursor: "pointer" }}>Error details</summary>
              <pre style={{ fontSize: 11, color: "#6b7280", whiteSpace: "pre-wrap", marginTop: 8, overflowX: "auto" }}>{this.state.error.message}</pre>
            </details>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/admin" component={AdminPage} />
      <Route path="/it-upload" component={ItUploadPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <OfflineBanner />
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
