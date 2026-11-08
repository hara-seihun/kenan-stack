package com.example.kenan.android

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject
import java.util.UUID

class DeviceStore(context: Context) : SQLiteOpenHelper(context, "device-receipts.db", null, 5) {
    val prefs = context.getSharedPreferences("kenan-next-device", Context.MODE_PRIVATE)
    val deviceId: String = prefs.getString("deviceId", null) ?: UUID.randomUUID().toString().also {
        check(prefs.edit().putString("deviceId", it).commit())
    }
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE receipt (id TEXT PRIMARY KEY, request TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('entered','terminal')), result TEXT, owner TEXT, wire TEXT, acknowledged INTEGER NOT NULL CHECK(acknowledged IN (0,1)))")
        db.execSQL("CREATE TABLE outbox (id TEXT PRIMARY KEY, owner TEXT NOT NULL, body TEXT NOT NULL)")
        db.execSQL("CREATE TABLE notice (id TEXT PRIMARY KEY, platform_id INTEGER UNIQUE NOT NULL, body TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0, is_read INTEGER NOT NULL DEFAULT 0)")
        createReplies(db)
    }
    override fun onConfigure(db: SQLiteDatabase) { db.execSQL("PRAGMA synchronous=FULL") }
    override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) {
        check(old in 1..4 && new == 5) { "Unknown receipt database version" }
        if (old == 1) {
            db.execSQL("ALTER TABLE receipt ADD COLUMN owner TEXT")
            db.execSQL("ALTER TABLE receipt ADD COLUMN wire TEXT")
            db.execSQL("ALTER TABLE receipt ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0")
        }
        if (old < 3) createReplies(db)
        if (old < 4) db.execSQL("ALTER TABLE notice ADD COLUMN settled INTEGER NOT NULL DEFAULT 0")
        db.execSQL("ALTER TABLE notice ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0")
    }
    private fun createReplies(db: SQLiteDatabase) { db.execSQL("CREATE TABLE released_reply (id TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation TEXT NOT NULL, audience_epoch INTEGER NOT NULL, payload TEXT NOT NULL)") }
    @Synchronized fun retainReply(owner: String, frame: JSONObject): Outcome<JSONObject> = boundary {
        val id = frame.getString("operationId"); UUID.fromString(id)
        val conversation = frame.getString("conversationId"); require(conversation.isNotBlank())
        val epoch = frame.getLong("audienceEpoch"); require(epoch >= 0)
        require(frame.getString("entryId").isNotBlank())
        val payload = canonical(frame)
        val db = writableDatabase; db.beginTransaction()
        try {
            var existing = false
            db.rawQuery("SELECT owner,payload FROM released_reply WHERE id=?", arrayOf(id)).use { row ->
                if (row.moveToFirst()) { require(row.getString(0) == owner && row.getString(1) == payload) { "Released reply identity conflicts with retained evidence" }; existing = true }
            }
            val latest = db.rawQuery("SELECT id,audience_epoch FROM released_reply WHERE owner=? AND conversation=? ORDER BY rowid DESC LIMIT 1", arrayOf(owner, conversation)).use { row ->
                if (row.moveToFirst()) row.getString(0) to row.getLong(1) else null
            }
            require(latest == null || epoch >= latest.second) { "Released reply audience epoch is stale" }
            if (!existing) db.insertOrThrow("released_reply", null, ContentValues().apply { put("id", id); put("owner", owner); put("conversation", conversation); put("audience_epoch", epoch); put("payload", payload) })
            db.setTransactionSuccessful()
            JSONObject().put("display", !existing || latest?.first == id)
        } finally { db.endTransaction() }
    }
    sealed interface Admission {
        data object New : Admission
        data class Retained(val result: JSONObject) : Admission
        data object Conflict : Admission
    }
    @Synchronized fun accept(command: DeviceCommand): Admission {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.rawQuery("SELECT request,state,result,owner FROM receipt WHERE id=?", arrayOf(command.id)).use { row ->
                if (row.moveToFirst()) {
                    if (row.getString(0) != command.canonical || row.getString(3) != prefs.getString("ownerId", null)) return Admission.Conflict
                    val result = if (row.getString(1) == "terminal") JSONObject(row.getString(2))
                    else Outcome.Err("outcome_uncertain", "Previously entered invocation has no terminal evidence; it will not execute again").json()
                    return Admission.Retained(result)
                }
            }
            db.insertOrThrow("receipt", null, ContentValues().apply {
                put("id", command.id); put("request", command.canonical); put("state", "entered"); put("acknowledged", 0)
                put("owner", prefs.getString("ownerId", null))
                if (command.name in DeviceManifest.COMMANDS) put("wire", JSONObject().put("type", "result").put("operationId", command.id).put("generation", command.generation).put("sessionEpoch", command.epoch).toString())
            })
            db.setTransactionSuccessful()
            return Admission.New
        } finally { db.endTransaction() }
    }
    @Synchronized fun finish(id: String, result: JSONObject) {
        check(writableDatabase.update("receipt", ContentValues().apply { put("state", "terminal"); put("result", result.toString()) }, "id=? AND state='entered'", arrayOf(id)) == 1)
    }
    fun enqueue(id: String, owner: String, body: JSONObject) {
        writableDatabase.insertOrThrow("outbox", null, ContentValues().apply { put("id", id); put("owner", owner); put("body", body.toString()) })
    }
    fun pending(owner: String): List<JSONObject> = readableDatabase.rawQuery("SELECT body FROM outbox WHERE owner=?", arrayOf(owner)).use { rows ->
        buildList { while (rows.moveToNext()) add(JSONObject(rows.getString(0))) }
    }
    fun acknowledge(id: String) {
        val owner = prefs.getString("ownerId", null) ?: return
        writableDatabase.delete("outbox", "id=? AND owner=?", arrayOf(id, owner))
        writableDatabase.update("receipt", ContentValues().apply { put("acknowledged", 1) }, "id=? AND owner=? AND state='terminal'", arrayOf(id, owner))
    }
    fun retainedResults(owner: String): List<JSONObject> = readableDatabase.rawQuery("SELECT wire,result FROM receipt WHERE owner=? AND state='terminal' AND acknowledged=0 AND wire IS NOT NULL", arrayOf(owner)).use { rows ->
        buildList { while (rows.moveToNext()) add(JSONObject(rows.getString(0)).put("result", JSONObject(rows.getString(1)))) }
    }
    fun notice(id: String, body: JSONObject): Int {
        readableDatabase.rawQuery("SELECT platform_id FROM notice WHERE id=?", arrayOf(id)).use { row -> if (row.moveToFirst()) return row.getInt(0) }
        val platform = readableDatabase.rawQuery("SELECT COALESCE(MAX(platform_id),1000)+1 FROM notice", null).use { it.moveToFirst(); it.getInt(0) }
        writableDatabase.insertOrThrow("notice", null, ContentValues().apply { put("id", id); put("platform_id", platform); put("body", body.toString()) })
        return platform
    }
    fun recentNotices(prefix: String, conversation: String): List<JSONObject> = readableDatabase.rawQuery(
        "SELECT body FROM notice WHERE substr(id,1,?)=? AND is_read=0 ORDER BY platform_id DESC", arrayOf(prefix.length.toString(), prefix)
    ).use { rows -> buildList { while (rows.moveToNext()) {
        val value = JSONObject(rows.getString(0))
        if (value.optString("conversationId") == conversation) add(value)
        if (size == 10) break
    } }.take(10).reversed() }
    /** A read receipt settles even notifications that couldn't be displayed yet. */
    fun readConversationNotices(prefix: String, conversation: String): List<Int> {
        val db = writableDatabase; db.beginTransaction()
        try {
            val notices = db.rawQuery("SELECT id,platform_id,body FROM notice WHERE substr(id,1,?)=? AND is_read=0", arrayOf(prefix.length.toString(), prefix)).use { rows ->
                buildList { while (rows.moveToNext()) if (JSONObject(rows.getString(2)).optString("conversationId") == conversation) add(rows.getString(0) to rows.getInt(1)) }
            }
            for ((id, _) in notices) db.update("notice", ContentValues().apply { put("is_read", 1); put("settled", 1) }, "id=?", arrayOf(id))
            db.setTransactionSuccessful()
            return notices.map { it.second }
        } finally { db.endTransaction() }
    }
    fun noticeSettled(id: String): Boolean = readableDatabase.rawQuery("SELECT settled FROM notice WHERE id=?", arrayOf(id)).use { row -> row.moveToFirst() && row.getInt(0) == 1 }
    fun settleNotice(id: String) { check(writableDatabase.update("notice", ContentValues().apply { put("settled", 1) }, "id=?", arrayOf(id)) == 1) }
    fun bind(owner: String, epoch: String, domain: String? = null) {
        val previous = prefs.getString("ownerId", null)
        val edit = prefs.edit().putString("ownerId", owner).putString("sessionEpoch", epoch).putString("domainId", domain)
        if (previous != null && previous != owner) edit.remove("noticeCursor").remove("conversationId")
        check(edit.commit())
    }
    fun clearSessionBinding() { check(prefs.edit().remove("sessionEpoch").remove("conversationId").commit()) }
    fun unbind() { check(prefs.edit().remove("sessionEpoch").remove("conversationId").putBoolean("overlayEnabled", false).commit()) }
}
