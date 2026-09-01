import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import "./zero-gamma.css";

class AppErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("Axiom UI runtime error", error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return <main style={{minHeight:"100vh",background:"#050a10",color:"#dbe7f3",display:"grid",placeItems:"center",padding:"32px",fontFamily:"monospace"}}>
      <section style={{maxWidth:"720px",width:"100%",border:"1px solid #31536d",borderRadius:"12px",padding:"28px",background:"#0a141e",boxShadow:"0 12px 40px #0008"}}>
        <p style={{color:"#63d8ff",letterSpacing:".12em",marginTop:0}}>AXIOM UI RECOVERY</p>
        <h1 style={{margin:"8px 0 12px",fontFamily:"sans-serif"}}>The dashboard hit a display error</h1>
        <p style={{color:"#a9bdcd",lineHeight:1.5}}>The data engine is not changed. Reload the dashboard to recover the interface.</p>
        <pre style={{whiteSpace:"pre-wrap",color:"#ff8b9e",background:"#06101a",padding:"12px",borderRadius:"6px",fontSize:"12px"}}>{this.state.error?.message || "Unknown UI error"}</pre>
        <button type="button" onClick={() => window.location.reload()} style={{background:"#56c8ed",color:"#06101a",border:0,borderRadius:"6px",padding:"10px 16px",fontWeight:700,cursor:"pointer"}}>RELOAD DASHBOARD</button>
      </section>
    </main>;
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </React.StrictMode>,
);
