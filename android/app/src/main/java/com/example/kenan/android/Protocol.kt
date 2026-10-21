package com.example.kenan.android

import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.UUID

sealed interface Outcome<out T> {
    data class Ok<T>(val value: T) : Outcome<T>
    data class Err(val code: String, val message: String) : Outcome<Nothing> {
        init { require(code in DeviceManifest.ERRORS) { "Undeclared protocol error: $code" } }
    }
}
fun Outcome<JSONObject>.json(): JSONObject = when (this) {
    is Outcome.Ok -> JSONObject().put("ok", true).put("value", value)
    is Outcome.Err -> JSONObject().put("ok", false).put("error", JSONObject().put("code", code).put("message", message))
}
fun boundary(action: () -> JSONObject): Outcome<JSONObject> = try { Outcome.Ok(action()) }
catch (e: SecurityException) { Outcome.Err("permission_missing", e.message ?: "Android denied this operation") }
catch (e: IllegalArgumentException) { Outcome.Err("invalid_input", e.message ?: "Invalid arguments") }
catch (e: Exception) { Outcome.Err("platform_failure", e.message ?: e.javaClass.simpleName) }

class Gateway private constructor(val origin: String) {
    companion object {
        fun parse(raw: String): Outcome<Gateway> = try {
            val uri = URI(raw)
            if (uri.scheme !in setOf("http", "https") || uri.host.isNullOrBlank() || uri.rawUserInfo != null ||
                uri.rawQuery != null || uri.rawFragment != null || uri.rawPath !in listOf("", "/")) {
                Outcome.Err("invalid_input", "Enter an exact http(s) gateway origin with no path or credentials")
            } else Outcome.Ok(Gateway("${uri.scheme}://${uri.host}${if (uri.port == -1) "" else ":${uri.port}"}"))
        } catch (e: Exception) { Outcome.Err("invalid_input", "Invalid gateway origin") }
    }
}

data class DeviceCommand(val id: String, val generation: Int, val deadline: Long, val epoch: String,
                         val name: String, val args: JSONObject, val confirmed: Boolean, val canonical: String) {
    companion object {
        fun parse(json: JSONObject): Outcome<DeviceCommand> = try {
            require(json.getString("type") == "command")
            val id = json.getString("operationId")
            UUID.fromString(id)
            val generation = json.getInt("generation"); require(generation >= 1)
            val deadline = json.getLong("deadline"); require(deadline > 0)
            val auth = json.getJSONObject("authorization")
            require(auth.getBoolean("phoneRequested")) { "An actual request to use the phone is required" }
            val name = json.getString("name"); require(name in DeviceManifest.COMMANDS)
            val epoch = json.getString("sessionEpoch"); require(epoch.isNotBlank())
            val payload = JSONObject().put("operationId", id).put("generation", generation).put("name", name)
                .put("args", json.getJSONObject("args")).put("authorization", auth)
            Outcome.Ok(DeviceCommand(id, generation, deadline, epoch,
                name, json.getJSONObject("args"), auth.getBoolean("confirmed"), canonical(payload)))
        } catch (e: Exception) { Outcome.Err("invalid_input", e.message ?: "Invalid device command") }
    }
}
fun sessionIdentity(cookies: String): String {
    val session = cookies.split(';').map(String::trim).single { it.startsWith("kenan_session=") }
    return java.security.MessageDigest.getInstance("SHA-256").digest(session.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
fun canonical(value: Any?): String = when (value) {
    null, JSONObject.NULL -> "null"
    is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { JSONObject.quote(it) + ":" + canonical(value.get(it)) }
    is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
    is String -> JSONObject.quote(value)
    is Boolean, is Number -> value.toString()
    else -> throw IllegalArgumentException("Unsupported JSON value")
}
