; One extra installer page, after the install directory: who JARVIS is talking
; to and which voice he speaks with. electron-builder picks this file up by name
; (build/installer.nsh) and inserts the macro below where its assisted installer
; offers a custom page.
;
; The answers go to %APPDATA%\JARVIS\jarvis.ini, read by electron/main.cjs on
; every launch, so they are the installer's to set and nobody's to compile in.
; Updates skip the page and leave the file exactly as it was. A manual
; reinstall shows the page again, filled in.

!macro customPageAfterChangeDir
  !include nsDialogs.nsh
  !include LogicLib.nsh

  Var JarvisName
  Var JarvisTitle
  Var JarvisVoice
  Var JarvisNameField
  Var JarvisTitleField
  Var JarvisVoiceField

  !define JARVIS_INI "$APPDATA\JARVIS\jarvis.ini"
  !define VOICE_PIPER "Piper — voz local em português (recomendada)"
  !define VOICE_SYSTEM "Voz do Windows"
  !define VOICE_KOKORO "Kokoro — voz neural em inglês britânico (lenta)"

  Page custom JarvisPageShow JarvisPageLeave

  Function JarvisPageShow
    ${if} ${isUpdated}
      Abort
    ${endif}
    !insertmacro MUI_HEADER_TEXT "Personalizar o J.A.R.V.I.S." "Como ele deve chamar você e com que voz deve falar."

    ReadINIStr $JarvisName "${JARVIS_INI}" interface user_name
    ReadINIStr $JarvisTitle "${JARVIS_INI}" interface user_title
    ReadINIStr $JarvisVoice "${JARVIS_INI}" interface tts_engine

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 12u "Seu nome:"
    Pop $0
    ${NSD_CreateText} 0 13u 100% 13u "$JarvisName"
    Pop $JarvisNameField

    ${NSD_CreateLabel} 0 36u 100% 12u "Tratamento:"
    Pop $0
    ${NSD_CreateDropList} 0 49u 50% 13u ""
    Pop $JarvisTitleField
    ${NSD_CB_AddString} $JarvisTitleField "senhor"
    ${NSD_CB_AddString} $JarvisTitleField "senhora"
    ${If} $JarvisTitle == "senhora"
      ${NSD_CB_SelectString} $JarvisTitleField "senhora"
    ${Else}
      ${NSD_CB_SelectString} $JarvisTitleField "senhor"
    ${EndIf}

    ${NSD_CreateLabel} 0 72u 100% 12u "Voz:"
    Pop $0
    ${NSD_CreateDropList} 0 85u 100% 13u ""
    Pop $JarvisVoiceField
    ${NSD_CB_AddString} $JarvisVoiceField "${VOICE_PIPER}"
    ${NSD_CB_AddString} $JarvisVoiceField "${VOICE_SYSTEM}"
    ${NSD_CB_AddString} $JarvisVoiceField "${VOICE_KOKORO}"
    ${If} $JarvisVoice == "system"
      ${NSD_CB_SelectString} $JarvisVoiceField "${VOICE_SYSTEM}"
    ${ElseIf} $JarvisVoice == "kokoro"
      ${NSD_CB_SelectString} $JarvisVoiceField "${VOICE_KOKORO}"
    ${Else}
      ${NSD_CB_SelectString} $JarvisVoiceField "${VOICE_PIPER}"
    ${EndIf}

    ${NSD_CreateLabel} 0 108u 100% 24u "Você pode mudar isso depois em %APPDATA%\JARVIS\jarvis.ini, ou instalando de novo."
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function JarvisPageLeave
    ${NSD_GetText} $JarvisNameField $JarvisName
    ${NSD_GetText} $JarvisTitleField $JarvisTitle
    ${NSD_GetText} $JarvisVoiceField $0
    ${If} $0 == "${VOICE_SYSTEM}"
      StrCpy $JarvisVoice "system"
    ${ElseIf} $0 == "${VOICE_KOKORO}"
      StrCpy $JarvisVoice "kokoro"
    ${Else}
      StrCpy $JarvisVoice "piper"
    ${EndIf}

    CreateDirectory "$APPDATA\JARVIS"
    ; A new file starts as UTF-16 with its BOM. WriteINIStr writes in whatever
    ; encoding the file already has, and a file it creates itself is in the
    ; ANSI code page — which would mangle any accent in the name.
    ${IfNot} ${FileExists} "${JARVIS_INI}"
      FileOpen $0 "${JARVIS_INI}" w
      FileWriteWord $0 0xFEFF
      FileClose $0
    ${EndIf}
    WriteINIStr "${JARVIS_INI}" interface user_name "$JarvisName"
    WriteINIStr "${JARVIS_INI}" interface user_title "$JarvisTitle"
    WriteINIStr "${JARVIS_INI}" interface tts_engine "$JarvisVoice"
  FunctionEnd
!macroend
