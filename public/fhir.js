function generateFHIR() {

    const bpm = document.getElementById('heartRate').innerText;

    const observation = {

        resourceType: "Observation",

        status: "final",

        code: {
            coding: [
                {
                    system: "http://loinc.org",
                    code: "8867-4",
                    display: "Heart rate"
                }
            ]
        },

        valueQuantity: {
            value: bpm,
            unit: "bpm"
        }
    };

    document.getElementById('fhirOutput').textContent =
        JSON.stringify(observation, null, 2);
}