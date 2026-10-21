package com.example.kenan.android

import org.junit.Assert.*
import org.junit.Test

class DownloadNameTest {
    @Test fun gatewayExtendedFilenameWinsAndPreservesUtf8() {
        assertEquals("native-upload-qa.txt", (downloadName("attachment; filename*=UTF-8''native-upload-qa.txt") as Outcome.Ok).value)
        assertEquals("résumé + notes.txt", (downloadName("attachment; filename=\"generic.bin\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%2B%20notes.txt") as Outcome.Ok).value)
        assertEquals("report.txt", (downloadName("attachment; filename=\"report.txt\"") as Outcome.Ok).value)
    }
    @Test fun unsetAndUnsafeNamesNeverInventAReplacement() {
        listOf("", "attachment", "attachment; filename=\"..\"", "attachment; filename*=UTF-8''..%2Fsecret", "attachment; filename*=UTF-8''bad%00name").forEach {
            assertTrue(it, downloadName(it) is Outcome.Err)
        }
    }
}
