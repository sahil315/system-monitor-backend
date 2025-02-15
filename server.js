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

// ✅ Extract Sensor Data
const extractSensorData = (node, type, output, keyMap = null) => {
    if (!node.Children) return;
    
    node.Children.forEach(sensor => {
        if (sensor.Type === type) {
            if (keyMap && keyMap[sensor.Text]) {
                output[keyMap[sensor.Text]] = sensor.Value || "N/A";
            } else {
                output.push({ name: sensor.Text, value: sensor.Value });
            }
        }
        extractSensorData(sensor, type, output, keyMap);
    });
};

// ✅ Cross-Platform Drive Partitions Fetcher
const getDrivePartitions = () => {
    try {
        let partitions = [];
        const driveInfo = execSync("df -h --output=target,size,used,avail | tail -n +2").toString();
        const lines = driveInfo.trim().split("\n");

        lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length === 4) {
                const mountPoint = parts[0]; // e.g. `/`, `/mnt/storage`
                const totalSpace = parts[1];
                const usedSpace = parts[2];
                const freeSpace = parts[3];

                // ✅ Keep only REAL storage devices
                if (
                    mountPoint !== "/" &&
                    !mountPoint.includes("/dev") &&
                    !mountPoint.includes("/tmp") &&
                    !mountPoint.includes("/etc/secrets") &&
                    !mountPoint.includes("/dev/shm") &&
                    !mountPoint.includes("/opt/render-ssh") &&
                    !mountPoint.includes("/proc") &&
                    !mountPoint.includes("/sys")
                ) {
                    partitions.push({
                        name: mountPoint, // Keep relevant names
                        total: totalSpace,
                        used: usedSpace,
                        free: freeSpace
                    });
                }
            }
        });

        return partitions;
    } catch (error) {
        console.error("❌ Error fetching drive partitions:", error);
        return [];
    }
};




// ✅ Function to Fetch System Stats
const fetchSystemStats = async () => {
    try {
        console.log(`📡 Fetching system stats from: ${API_URL}`);
        const response = await axios.get(API_URL, {
            auth: { username: "admin", password: "newPassword" }
        });

        if (!response.data || !response.data.Children) {
            throw new Error("Invalid response format from Libre Hardware Monitor.");
        }

        const systemData = response.data.Children[0];

        // ✅ Initialize data storage
        const cpu = { voltage: [], temp: [], load: [], fan_rpm: [], clock: [], power: [] };
        const motherboard = { voltages: [], temps: [], fans: [] };
        const ram = { load: "N/A", used: "N/A", available: "N/A" };
        const gpu = { fan_rpm: [], load: [], clock: [], memory: {}, temp: [] };
       
        const network = { sent: "N/A", received: "N/A", uploaded: "N/A", downloaded: "N/A", utilization: "N/A" };
        const drives = [];
            let wdBlueDrive = {
                name: "WD Blue SN580 2TB",
                used: "N/A",
                temperature: "N/A",
                read_speed: "N/A",
                write_speed: "N/A",
                partitions: getDrivePartitions()
            };
        // ✅ Traverse System Data
        systemData.Children.forEach((component) => {
            if (component.Text.includes("Gigabyte")) {
                const mbChip = component.Children[0];
                if (mbChip && mbChip.Children) {
                    mbChip.Children.forEach(sensorGroup => {
                        if (sensorGroup.Text === "Voltages") extractSensorData(sensorGroup, "Voltage", motherboard.voltages);
                        if (sensorGroup.Text === "Temperatures") extractSensorData(sensorGroup, "Temperature", motherboard.temps);
                        if (sensorGroup.Text === "Fans") extractSensorData(sensorGroup, "Fan", motherboard.fans);
                    });
                }
            }

            if (component.Text.includes("Intel Core")) {
                component.Children.forEach(sensorGroup => {
                    if (sensorGroup.Text === "Voltages") extractSensorData(sensorGroup, "Voltage", cpu.voltage);
                    if (sensorGroup.Text === "Temperatures") extractSensorData(sensorGroup, "Temperature", cpu.temp);
                    if (sensorGroup.Text === "Load") extractSensorData(sensorGroup, "Load", cpu.load);
                    if (sensorGroup.Text === "Fans") extractSensorData(sensorGroup, "Fan", cpu.fan_rpm);
                    if (sensorGroup.Text === "Clocks") extractSensorData(sensorGroup, "Clock", cpu.clock);
                    if (sensorGroup.Text === "Powers") extractSensorData(sensorGroup, "Power", cpu.power);
                });
            }
            if (component.Text.includes("NVIDIA GeForce")) {
                component.Children.forEach(sensorGroup => {
                    if (sensorGroup.Text === "Clocks") extractSensorData(sensorGroup, "Clock", gpu.clock);
                    if (sensorGroup.Text === "Temperatures") extractSensorData(sensorGroup, "Temperature", gpu.temp);
                    if (sensorGroup.Text === "Load") extractSensorData(sensorGroup, "Load", gpu.load);
                    if (sensorGroup.Text === "Fans") extractSensorData(sensorGroup, "Fan", gpu.fan_rpm);
                    if (sensorGroup.Text === "Data") {
                        sensorGroup.Children.forEach(memSensor => {
                            gpu.memory[memSensor.Text] = memSensor.Value;
                        });
                    }
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

           if (component.Text === "Ethernet") {
                console.log("📡 Found Ethernet Component:", component);
            
                component.Children.forEach(sensorGroup => {
                    if (sensorGroup.Text === "Load") {
                        extractSensorData(sensorGroup, "Load", network, {
                            "Network Utilization": "utilization"
                        });
                    }
            
                    if (sensorGroup.Text === "Data") {
                        extractSensorData(sensorGroup, "Data", network, {
                            "Data Uploaded": "uploaded",
                            "Data Downloaded": "downloaded"
                        });
                    }
            
                    if (sensorGroup.Text === "Throughput") {
                        extractSensorData(sensorGroup, "Throughput", network, {
                            "Upload Speed": "sent",
                            "Download Speed": "received"
                        });
                    }
                });
            
                console.log("✅ Extracted Network Stats:", network);
            }

                
                // Modify this part in fetchSystemStats()
               if (component.Text.includes("WD Blue")) {
                component.Children.forEach(sensorGroup => {
                    if (sensorGroup.Text === "Load") {
                        wdBlueDrive.used = sensorGroup.Children.find(item => item.Text === "Used Space")?.Value || "N/A";
                    }
                    if (sensorGroup.Text === "Temperatures") {
                        wdBlueDrive.temperature = sensorGroup.Children.find(item => item.Text === "Temperature")?.Value || "N/A";
                    }
                    if (sensorGroup.Text === "Throughput") {
                        wdBlueDrive.read_speed = sensorGroup.Children.find(item => item.Text === "Read Rate")?.Value || "N/A";
                        wdBlueDrive.write_speed = sensorGroup.Children.find(item => item.Text === "Write Rate")?.Value || "N/A";
                    }
                });
            }
        // ✅ Keep only WD Blue in `drives` array
        drives.push(wdBlueDrive);


           
        });

        return { hostname: systemData.Text, os: os.platform(), uptime: os.uptime(), cpu, motherboard, ram, gpu, drives, network };
    } catch (error) {
        console.error("⚠️ Failed to fetch system stats:", error.message);
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
