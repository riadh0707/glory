; Le terminal Glory ouvre une connexion ENTRANTE vers ce PC pour envoyer ses
; événements (paiement en cours, niveaux, erreurs). Sans règle de pare-feu,
; Windows la bloque sur une installation neuve : plus d'affichage en direct.
; L'installation étant par utilisateur (sans droits admin), la règle est
; ajoutée via une élévation explicite (une seule demande UAC).

!macro customInstall
  ExecShellWait "runas" "$SYSDIR\cmd.exe" '/c netsh advfirewall firewall delete rule name="Glory FCC Client" & netsh advfirewall firewall add rule name="Glory FCC Client" dir=in action=allow program="$INSTDIR\Glory FCC Client.exe" enable=yes profile=any' SW_HIDE
!macroend

!macro customUnInstall
  ExecShellWait "runas" "$SYSDIR\cmd.exe" '/c netsh advfirewall firewall delete rule name="Glory FCC Client"' SW_HIDE
!macroend
