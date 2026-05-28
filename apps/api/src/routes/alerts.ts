import { Router, Request, Response } from "express";
import { supabase } from "../db/client";
import webpush from "web-push";
import { z } from "zod";

if (!process.env.API_SECRET_KEY) {
    console.error("CRITICAL ERROR: API_SECRET_KEY is not set. Terminating.");
    process.exit(1);
}

const AlertSchema = z.object({
    brand: z.string().optional(),
    batch: z.string().optional(),
    manufacturer: z.string().optional(),
    alert_type: z.string().optional(),
    reason: z.string().optional(),
    state_district: z.string().optional(),
    date: z.string().optional(),
}).passthrough();

const AlertsArraySchema = z.array(AlertSchema);

// Configure web-push with VAPID details
if (process.env.WEB_PUSH_VAPID_PUBLIC_KEY && process.env.WEB_PUSH_VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        process.env.WEB_PUSH_CONTACT || "mailto:support@sahidawa.in",
        process.env.WEB_PUSH_VAPID_PUBLIC_KEY,
        process.env.WEB_PUSH_VAPID_PRIVATE_KEY
    );
}


const alertsRouter = Router();

/**
 * GET /api/v1/alerts
 * Paginated alerts endpoint.
 *
 * Query params:
 *   page  — 1-based page index (default: 1)
 *   limit — items per page (default: 10, max: 100)
 *
 * Response schema:
 *   {
 *     data:           Alert[],
 *     pageIndex:      number,   // current page (1-based)
 *     pageSize:       number,   // items returned on this page
 *     totalCount:     number,   // total rows in the table
 *     totalPageCount: number,   // ceil(totalCount / limit)
 *   }
 */
alertsRouter.get("/", async (req: Request, res: Response) => {
    const rawPage = parseInt(req.query.page as string, 10);
    const rawLimit = parseInt(req.query.limit as string, 10);
    const brand = req.query.brand as string;
    const region = req.query.region as string;

    const page = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
    const limit = isNaN(rawLimit) || rawLimit < 1 ? 10 : Math.min(rawLimit, 100);

    const offset = (page - 1) * limit;

    let query = supabase.from("drug_alerts").select("*", { count: "exact" });
    
    if (brand) {
        query = query.ilike("brand", `%${brand}%`);
    }
    if (region) {
        query = query.ilike("state_district", `%${region}%`);
    }

    const { data, error, count } = await query
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

    if (error) {
        res.status(500).json({ error: "Failed to fetch alerts" });
        return;
    }

    const totalCount = count ?? 0;
    const totalPageCount = Math.ceil(totalCount / limit);

    res.json({
        data: data ?? [],
        pageIndex: page,
        pageSize: (data ?? []).length,
        totalCount,
        totalPageCount,
    });
});

/**
 * POST /api/v1/alerts/ingest
 * Protected endpoint to ingest parsed CDSCO alerts from the ML agent.
 */
alertsRouter.post("/ingest", async (req: Request, res: Response) => {
    // 1. Validate Secret Header
    const authHeader = req.headers["x-api-secret"];
    const expectedSecret = process.env.API_SECRET_KEY;

    if (!authHeader || authHeader !== expectedSecret) {
        res.status(401).json({ error: "Unauthorized access" });
        return;
    }

    const { alerts } = req.body;
    const parseResult = AlertsArraySchema.safeParse(alerts);
    if (!parseResult.success) {
        res.status(400).json({ error: "Invalid payload schema", details: parseResult.error });
        return;
    }
    
    const validatedAlerts = parseResult.data;

    try {
        // 2. Insert alerts into drug_alerts table
        const { data: insertedAlerts, error: insertError } = await supabase
            .from("drug_alerts")
            .insert(validatedAlerts)
            .select();

        if (insertError) {
            console.error("Error inserting alerts:", insertError);
            res.status(500).json({ error: "Database error inserting alerts" });
            return;
        }

        // 3. Update medicines table based on matched batches
        const updatePromises = validatedAlerts.map(alert => {
            if (alert.batch) {
                let q = supabase
                    .from("medicines")
                    .update({ status: "recalled", is_counterfeit_alert: true })
                    .eq("batch_number", alert.batch);
                
                if (alert.manufacturer) {
                    q = q.eq("manufacturer", alert.manufacturer);
                } else if (alert.brand) {
                    q = q.eq("brand_name", alert.brand);
                }
                return q;
            }
            return Promise.resolve();
        });
        
        await Promise.all(updatePromises);

        // 4. Dispatch Web Push Notifications
        const { data: subscriptions, error: subError } = await supabase
            .from("push_subscriptions")
            .select("*");

        if (!subError && subscriptions && subscriptions.length > 0) {
            const pushPayload = JSON.stringify({
                title: "New CDSCO Drug Alert",
                body: `A new drug recall has been issued. Check the alerts page for details.`,
                icon: "/icon.png", // Assuming an icon exists at this route
                url: "/alerts"
            });

            const pushPromises = subscriptions.map((sub: any) => {
                const pushSubscription = {
                    endpoint: sub.endpoint,
                    keys: {
                        p256dh: sub.p256dh,
                        auth: sub.auth
                    }
                };
                return webpush.sendNotification(pushSubscription, pushPayload).catch(async err => {
                    console.error("Error sending push notification to endpoint:", sub.endpoint, err);
                    if (err.statusCode === 404 || err.statusCode === 410) {
                        console.log("Removing dead subscription:", sub.endpoint);
                        await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
                    }
                });
            });

            await Promise.all(pushPromises);
        }

        res.status(200).json({ success: true, message: "Alerts ingested and notifications dispatched", inserted: insertedAlerts?.length });
    } catch (error) {
        console.error("Unexpected error in /ingest:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

export default alertsRouter;