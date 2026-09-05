import axios from '@/lib/axios';
import {
    TerminationRequest,
    CreateTerminationRequestDto,
    ApproveTerminationDto,
    RejectTerminationDto,
} from '@/types/termination-request';

export const terminationRequestService = {
    // Create a new termination request
    async createTerminationRequest(data: CreateTerminationRequestDto): Promise<TerminationRequest> {
        const response = await axios.post('/contracts/termination-requests', data);
        return response.data.data;
    },

    // Get pending termination requests
    async getPendingTerminations(): Promise<TerminationRequest[]> {
        console.log('terminationRequestService.getPendingTerminations called');
        const response = await axios.get('/contracts/termination-requests/pending');
        console.log('Axios response:', response);
        console.log('Response data:', response.data);

        // Check if response.data is already the array (axios interceptor unwrapped it)
        if (Array.isArray(response.data)) {
            console.log('Response.data is array, returning directly');
            return response.data;
        }

        // Otherwise, try response.data.data
        console.log('Response data.data:', response.data.data);
        return response.data.data || response.data;
    },

    // Get a specific termination request
    async getTerminationRequest(id: string): Promise<TerminationRequest> {
        const response = await axios.get(`/contracts/termination-requests/${id}`);
        return response.data.data;
    },

    // Get resolved (approved/rejected) termination requests for the History tab
    async getTerminationHistory(): Promise<TerminationRequest[]> {
        const response = await axios.get('/contracts/termination-requests/history');
        if (Array.isArray(response.data)) {
            return response.data;
        }
        return response.data.data || response.data;
    },

    // Get termination requests by contract
    async getTerminationRequestsByContract(contractId: string): Promise<TerminationRequest[]> {
        const response = await axios.get(`/contracts/${contractId}/termination-requests`);
        return response.data.data;
    },

    // Alias for getTerminationRequestsByContract
    async getByContract(contractId: string): Promise<{ success: boolean; data: TerminationRequest[] }> {
        const response = await axios.get(`/contracts/${contractId}/termination-requests`);
        return { success: true, data: response.data.data || response.data };
    },

    // Approve a termination request
    async approveTermination(id: string, data: ApproveTerminationDto): Promise<TerminationRequest> {
        const response = await axios.post(`/contracts/termination-requests/${id}/approve`, data);
        return response.data.data;
    },

    // Reject a termination request
    async rejectTermination(id: string, data: RejectTerminationDto): Promise<TerminationRequest> {
        const response = await axios.post(`/contracts/termination-requests/${id}/reject`, data);
        return response.data.data;
    },
};

export default terminationRequestService;
