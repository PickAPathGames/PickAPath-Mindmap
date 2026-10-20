// tauri-app/src/App.tsx
import { ReactFlowProvider } from "@xyflow/react";
import { Canvas } from "./Canvas";
import "@xyflow/react/dist/style.css";

function App() {
  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <ReactFlowProvider>
        <Canvas />
      </ReactFlowProvider>
    </div>
  );
}

export default App;