const express = require("express");
const WebSocket = require("ws");
const axios = require("axios");
const cors = require("cors");
const os = require("os");
const { execSync } = require("child_process");
require("dotenv").config(); // Load environment variables

const app = express();

// ✅ Allow CORS
app.use(cors({
    origin: "*",
    allowedHeaders: ["x-api-key", "Content-Type", "Authorization"],
    exposedHeaders: ["x-api-key"]
}));

// ✅ Middleware for API Key Authentication
app.use((req, res, next) => {
    const receivedKey = req.headers["x-api-key"];
    const expectedKey = process.env.API_KEY;

    if (!receivedKey || receivedKey !== expectedKey) {
        console.warn("🚨 Unauthorized request detected!");
        return res.status(403).json({ error: "Unauthorized" });
    }
    next();
});

const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

const API_URL = "https://libre.pcstats.site/data.json";

// ✅ Function to Fetch System Stats
const fetchSystemStats = async () => {
    try {
        console.log(`📡 Fetching system stats from: ${API_URL}`);

        // Fetch without authentication
        const response = await axios.get(API_URL);
        if (!response.data || !response.data.Children) {
            throw new Error("Invalid response format from Libre Hardware Monitor.");
        }

        const systemData = response.data.Children[0];

        // Initialize data storage
        const cpu = { voltage: [], temp: [], load: [], fan_rpm: [], clock: [], power: [] };
        const motherboard = { voltages: [], temps: [], fans: [] };
        const ram = { load: "N/A", used: "N/A", available: "N/A" };
        const gpu = { fan_rpm: [], load: [], clock: [], memory: {}, temp: [] };
        const drives = [];
        const network = { sent: "N/A", received: "N/A", uploaded: "N/A", downloaded: "N/A", utilization: "N/A" };

        // Traverse system data
        if (systemData.Children) {
            systemData.Children.forEach((component) => {
                if (component.Text.includes("Gigabyte")) {
                    const mbChip = component.Children[0]; 
                    if (mbChip && mbChip.Children) {
                        mbChip.Children.forEach(sensorGroup => {
                            if (sensorGroup.Text === "Voltages") motherboard.voltages.push(sensorGroup);
                            if (sensorGroup.Text === "Temperatures") motherboard.temps.push(sensorGroup);
                            if (sensorGroup.Text === "Fans") motherboard.fans.push(sensorGroup);
                        });
                    }
                }

                if (component.Text.includes("Intel Core")) {
                    component.Children.forEach(sensorGroup => {
                        if (sensorGroup.Text === "Voltages") cpu.voltage.push(sensorGroup);
                        if (sensorGroup.Text === "Temperatures") cpu.temp.push(sensorGroup);
                        if (sensorGroup.Text === "Load") cpu.load.push(sensorGroup);
                        if (sensorGroup.Text === "Fans") cpu.fan_rpm.push(sensorGroup);
                        if (sensorGroup.Text === "Clocks") cpu.clock.push(sensorGroup);
                        if (sensorGroup.Text === "Powers") cpu.power.push(sensorGroup);
                    });
                }

                if (component.Text.includes("Memory")) {
                    component.Children.forEach(sensorGroup => {
                        if (sensorGroup.Text === "Load") {
                            ram.load = sensorGroup.Children[0]?.Value || "N/A";
                        }
                        if (sensorGroup.Text === "Data") {
                            ram.used = sensorGroup.Children.find(item => item.Text === "Memory Used")?.Value || "N/A";
                            ram.available = sensorGroup.Children.find(item => item.Text === "Memory Available")?.Value || "N/A";
                        }
                    });
                }

                if (component.Text.includes("NVIDIA GeForce")) {
                    component.Children.forEach(sensorGroup => {
                        if (sensorGroup.Text === "Clocks") gpu.clock.push(sensorGroup);
                        if (sensorGroup.Text === "Temperatures") gpu.temp.push(sensorGroup);
                        if (sensorGroup.Text === "Load") gpu.load.push(sensorGroup);
                        if (sensorGroup.Text === "Fans") gpu.fan_rpm.push(sensorGroup);
                        if (sensorGroup.Text === "Data") {
                            sensorGroup.Children.forEach(memSensor => {
                                gpu.memory[memSensor.Text] = memSensor.Value;
                            });
                        }
                    });
                }
            });
        }

        return {
            hostname: systemData.Text,
            os: os.platform(),
            uptime: os.uptime(),
            cpu,
            motherboard,
            ram,
            gpu,
            drives,
            network
        };
    } catch (error) {
        console.error("Failed to fetch system stats:", error.message);
        return null;
    }
};

// ✅ Store last sent system stats
let previousStats = null;

// ✅ Function to detect changed values
const getChangedValues = (newStats, oldStats) => {
    if (!oldStats) return newStats; // First-time connection, send all data

    let changedStats = {};
    for (let key in newStats) {
        if (JSON.stringify(newStats[key]) !== JSON.stringify(oldStats[key])) {
            changedStats[key] = newStats[key]; // Send only changed values
        }
    }
    return Object.keys(changedStats).length > 0 ? changedStats : null;
};

// ✅ WebSocket Connection Handling
wss.on("connection", async (ws) => {
    console.log("✅ New WebSocket connection established.");

    ws.on("message", async (message) => {
        try {
            const data = JSON.parse(message);
            if (!data.api_key || data.api_key !== process.env.API_KEY) {
                console.warn("🚨 WebSocket Unauthorized request!");
                ws.close(1008, "Unauthorized");
                return;
            }
            console.log("✅ WebSocket authenticated successfully.");

            // Send full data on first connection
            const fullStats = await fetchSystemStats();
            ws.send(JSON.stringify(fullStats));
            previousStats = fullStats;

            // Function to send only changed stats
            const sendStats = async () => {
                try {
                    const newStats = await fetchSystemStats();
                    const changedStats = getChangedValues(newStats, previousStats);

                    if (changedStats) {
                        ws.send(JSON.stringify(changedStats));
                        previousStats = newStats;
                    }
                } catch (err) {
                    console.error("❌ Error sending stats:", err);
                }
            };

            // Send updates every second
            const interval = setInterval(sendStats, 1000);

            ws.on("close", () => {
                console.log("⚠️ WebSocket connection closed.");
                clearInterval(interval);
            });

        } catch (error) {
            console.error("❌ Error parsing WebSocket message:", error);
        }
    });
});

// ✅ REST API Endpoint
app.get("/stats", async (req, res) => {
    try {
        const stats = await fetchSystemStats();
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch system stats" });
    }
});

// ✅ Start the Server
const PORT = 5000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
