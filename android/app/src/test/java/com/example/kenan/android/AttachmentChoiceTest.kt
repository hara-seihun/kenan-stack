package com.example.kenan.android
import org.junit.Assert.assertEquals
import org.junit.Test
class AttachmentChoiceTest {
    @Test fun dedicatedInputsKeepTheirPurpose() {
        assertEquals(AttachmentChoice.FILE, attachmentChoice(emptyArray(), false))
        assertEquals(AttachmentChoice.FILE, attachmentChoice(arrayOf("*/*"), false))
        assertEquals(AttachmentChoice.PHOTO, attachmentChoice(arrayOf("image/*"), false))
        assertEquals(AttachmentChoice.CAMERA, attachmentChoice(arrayOf("image/*"), true))
        assertEquals(AttachmentChoice.PHOTO, attachmentChoice(arrayOf("image/png,image/jpeg"), false))
        assertEquals(AttachmentChoice.FILE, attachmentChoice(arrayOf("image/*", "application/pdf"), true))
        assertEquals(AttachmentChoice.FILE, attachmentChoice(arrayOf("video/*"), true))
    }
}
