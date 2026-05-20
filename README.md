# 🩺 DoctoLine – Plateforme de téléconsultation

Plateforme web de téléconsultation médicale conforme aux exigences du projet :
- Gestion patients/médecins
- Prise de RDV avec calendrier
- Téléconsultation WebRTC (STUN + TURN coturn)
- Pseudo-capteur simulé (FC, température, SpO2) en temps réel
- Ressources FHIR Observation avec LOINC + SNOMED CT
- Messagerie textuelle intégrée

---

## 1. Prérequis

- Node.js (v18+)
- Certificats SSL générés avec mkcert
- coturn installé et configuré sur la VM Server-Turn

---

## 2. Installation

```bash
# Sur la VM principale (192.168.23.129)
cd /home/iut/plateforme-teleconsultation
npm install
```

---

## 3. Certificats SSL (mkcert)

```bash
sudo apt install mkcert
mkcert -install
mkdir ~/certs && cd ~/certs
mkcert 192.168.23.129
```

Les fichiers générés :
- `192.168.23.129-key.pem` → clé privée
- `192.168.23.129.pem` → certificat

---

## 4. Configuration coturn (/etc/turnserver.conf)

```
listening-port=3478
listening-ip=0.0.0.0
relay-ip=192.168.23.129
external-ip=192.168.23.129
fingerprint
lt-cred-mech
user=patient:patient123
user=medecin:medecin123
```

Démarrer coturn :
```bash
sudo systemctl start coturn
sudo systemctl status coturn
```

---

## 5. Démarrage du serveur Node.js

```bash
cd /home/iut/plateforme-teleconsultation
npm start
# → https://192.168.23.129:3443
```

---

## 6. Comptes de démonstration

L'application crée automatiquement au premier lancement :

| Rôle | Email | Mot de passe |
|------|-------|-------------|
| Patient | patient@test.fr | patient123 |
| Médecin | medecin@test.fr | medecin123 |

---

## 7. Scénario de démonstration (imposé)

### Étape 1 – Connexion patient
- Ouvrir https://192.168.23.129:3443 dans un onglet
- Se connecter avec `patient@test.fr / patient123`

### Étape 2 – Connexion médecin
- Ouvrir https://192.168.23.129:3443 dans un autre onglet (ou autre machine)
- Se connecter avec `medecin@test.fr / medecin123`

### Étape 3 – Sélection d'un médecin (côté patient)
- Onglet Médecins → cliquer "Prendre RDV" sur Dr. Jean
- Choisir une date et un créneau → Confirmer

### Étape 4 – Lancement de la consultation
- Côté patient : onglet "Mes RDV" → bouton "Démarrer consultation"
- OU côté médecin : onglet "Rendez-vous" → bouton "Démarrer consultation"

### Étape 5 – Établissement WebRTC
- L'autre partie voit la fenêtre d'appel entrant
- Cliquer sur le bouton vert pour accepter
- La connexion WebRTC s'établit (STUN puis TURN si nécessaire)
- Indicateur de statut : "Connexion établie ✓"

### Étape 6 – Capteurs en temps réel
- Le panneau "Capteurs biométriques simulés" s'active automatiquement
- FC, Température, SpO2 se mettent à jour toutes les 2 secondes
- Graphique de la fréquence cardiaque visible en temps réel
- Les deux participants voient les mêmes données

### Étape 7 & 8 – Ressource FHIR
- Cliquer "Générer ressource FHIR Observation"
- Cliquer "Voir JSON" pour afficher le JSON
- Montrer les 3 ressources : FC (LOINC 8867-4), Temp (LOINC 8310-5), SpO2 (LOINC 2708-6)
- Localisation SpO2 avec SNOMED CT code 7569003

### Étape 9 – Rôle du serveur TURN
- Expliquer : "STUN permet à chaque client de découvrir son IP publique.
  TURN est un relais : si la connexion P2P est impossible (NAT symétrique, firewall),
  tout le flux audio/vidéo passe par le serveur TURN coturn configuré sur 192.168.23.129:3478.
  Les credentials patient/medecin sont configurés dans /etc/turnserver.conf."

---

## 8. Architecture technique

```
Client A (Patient)          Serveur Node.js           Client B (Médecin)
    |                      (192.168.23.129:3443)            |
    |──── HTTPS/Socket.IO ──────────────────────────────────|
    |          Signal : offer/answer/ICE                     |
    |                                                        |
    |◄────────── WebRTC P2P (audio/vidéo) ─────────────────►|
    |         (via STUN Google + TURN coturn)               |
```

### Signalisation WebRTC (Socket.IO)
1. `call:request` → initier un appel
2. `call:accept` → accepter
3. `webrtc:offer` → SDP offer de l'initiateur
4. `webrtc:answer` → SDP answer du répondant
5. `webrtc:ice-candidate` → échange des candidats ICE

### ICE (Interactive Connectivity Establishment)
- **STUN** : stun.l.google.com:19302 → découverte de l'IP publique
- **TURN** : 192.168.23.129:3478 → relai si P2P impossible
- Négociation automatique : P2P d'abord, TURN en fallback

---

## 9. Ressources FHIR produites

### Fréquence cardiaque
- Code LOINC : **8867-4** (Heart rate)
- Unité UCUM : /min
- Interprétation : L/N/H selon < 60, 60-100, > 100 bpm

### Température corporelle
- Code LOINC : **8310-5** (Body temperature)
- Unité UCUM : Cel
- Interprétation : H si > 37.8°C

### Saturation SpO2
- Code LOINC : **2708-6** (Oxygen saturation in Arterial blood)
- Unité UCUM : %
- Site SNOMED CT : **7569003** (Finger structure)
- Interprétation : L si < 95%
